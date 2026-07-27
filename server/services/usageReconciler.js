/**
 * Replace PortOS's estimated per-run token counts with the CLI's own measured
 * counts, read from the transcripts the coding CLIs already write to disk.
 *
 * PortOS estimates output from captured stdout (a repainted ANSI screen for TUI
 * providers) and input from `promptLength` — the initial task description only,
 * which omits the per-turn context replay and prompt-cache traffic that dominate
 * real API cost. The result understated cost by orders of magnitude (#3124).
 * Claude Code and Codex both write real per-message counts locally, so the fix
 * is to read them: no provider call, no tokens spent, no network.
 *
 * Correlation has no shared identifier to work with — PortOS never captured the
 * CLI's own session id — so a run is matched to a transcript by
 * (a) working directory and (b) timestamp overlap with `[startTime, endTime]`:
 *
 *   Claude Code — the project directory name IS the slugified cwd, so the
 *     candidate set is exact; each session file is then windowed by timestamp.
 *   Codex — rollouts are filed by date, so we scan the run's date directories
 *     and keep sessions whose `session_meta.cwd` matches.
 *
 * When nothing matches (a provider that writes no transcript, an unreadable
 * home directory, an ambiguous window) the caller falls back to the existing
 * estimate — `reconcileRunUsage` reports which happened via `source`, so the
 * report can mark measured rows apart from estimated ones. Reading a transcript
 * is best-effort by design: a failure here must never fail the run it describes.
 */

import { homedir } from 'os';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { tryReadFile } from '../lib/fileUtils.js';
import { estimateTokens, estimateTokensFromChars } from '../lib/contextBudget.js';
import {
  claudeProjectSlug,
  parseClaudeTranscript,
  parseCodexRollout,
  totalTranscriptTokens
} from '../lib/providerTranscriptUsage.js';
import { recordRunUsage } from './usage.js';

// Widen the correlation window past the recorded run bounds: the CLI writes its
// first line slightly before PortOS stamps startTime, and flushes its last
// after the process exits. A minute of slack captures both without reaching
// into a neighbouring run (PortOS runs of the same provider in the same cwd are
// serialized well outside this margin).
const WINDOW_SLACK_MS = 60_000;

// A run is attributed only to transcripts whose cwd matches. A CoS agent works
// in a git worktree under the install's data dir, so the worktree path — not the
// install root — is what the CLI records; matching is therefore exact on the
// recorded `workspacePath`, with a prefix allowance for a CLI invoked in a
// subdirectory of the workspace (`server/`, `client/`).
const cwdMatches = (transcriptCwd, workspacePath) => {
  if (!transcriptCwd || !workspacePath) return false;
  if (transcriptCwd === workspacePath) return true;
  return transcriptCwd.startsWith(`${workspacePath}/`);
};

const CLAUDE_ID = /claude/i;
const CODEX_ID = /codex/i;


/**
 * Which transcript family a provider writes, or null for providers that write
 * none (ollama, LM Studio, agy, grok, any API provider). Keyed off the provider
 * id and command, mirroring `providerModels.js`'s predicates — but kept local so
 * this service stays reachable from the completion hook without pulling in the
 * provider graph.
 * @param {{ providerId?: string|null, command?: string|null }} run
 * @returns {'claude'|'codex'|null}
 */
export function transcriptFamily({ providerId = null, command = null } = {}) {
  const haystack = `${providerId || ''} ${command || ''}`;
  // Order matters: a `claude-code` provider id contains neither codex nor grok,
  // but check codex first so a hypothetical `codex-claude` wrapper resolves to
  // the CLI that actually writes the rollout.
  if (CODEX_ID.test(haystack)) return 'codex';
  if (CLAUDE_ID.test(haystack)) return 'claude';
  return null;
}

/** List a directory, returning [] when it doesn't exist or can't be read. */
const listDir = async (dir) => readdir(dir).catch(() => []);

/**
 * Every date directory (`YYYY/MM/DD`) a run could have written a Codex rollout
 * into. A run spanning midnight (or a UTC/local boundary) touches two days, so
 * the window's start and end days are both included.
 */
function codexDateDirs(root, fromMs, toMs) {
  const days = new Set();
  const start = Number.isFinite(fromMs) ? fromMs : Date.now();
  const end = Number.isFinite(toMs) ? toMs : start;
  // Step a day at a time from start to end, plus a day either side for
  // timezone skew between the CLI's clock and ours.
  for (let ms = start - 86_400_000; ms <= end + 86_400_000; ms += 86_400_000) {
    const d = new Date(ms);
    days.add(join(
      root,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0')
    ));
    // The CLI files rollouts by LOCAL date; add that path too.
    days.add(join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ));
  }
  return [...days];
}

/**
 * Sum every transcript that overlaps a run's window in its working directory.
 * Returns null when no transcript could be attributed (so the caller keeps its
 * estimate rather than recording a measured zero).
 *
 * @param {object} run
 * @param {string} run.workspacePath cwd the run executed in
 * @param {string|null} run.startTime ISO
 * @param {string|null} run.endTime ISO
 * @param {'claude'|'codex'} run.family
 * @param {string} [run.home] override for tests
 * @returns {Promise<null|{ source: 'measured', family: string, sessions: number,
 *   model: string|null, messages: number, tokensIn: number, tokensOut: number,
 *   cacheReadTokens: number, cacheWriteTokens: number }>}
 */
export async function readMeasuredUsage({ workspacePath, startTime, endTime, family, home = homedir() } = {}) {
  if (!workspacePath || !family) return null;

  const startMs = Date.parse(startTime || '');
  const endMs = Date.parse(endTime || '');
  const from = Number.isNaN(startMs) ? null : startMs - WINDOW_SLACK_MS;
  const to = Number.isNaN(endMs) ? null : endMs + WINDOW_SLACK_MS;

  const totals = {
    source: 'measured',
    family,
    sessions: 0,
    model: null,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  };
  const modelCounts = new Map();

  const fold = (parsed) => {
    if (!parsed || totalTranscriptTokens(parsed) === 0) return;
    totals.sessions += 1;
    totals.messages += parsed.messages || 0;
    totals.tokensIn += parsed.tokensIn || 0;
    totals.tokensOut += parsed.tokensOut || 0;
    totals.cacheReadTokens += parsed.cacheReadTokens || 0;
    totals.cacheWriteTokens += parsed.cacheWriteTokens || 0;
    for (const model of parsed.models?.length ? parsed.models : [parsed.model]) {
      if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    }
  };

  if (family === 'claude') {
    // The project directory name is the slugified cwd — an exact lookup, with
    // no directory scan and no chance of picking up another repo's sessions.
    const projectDir = join(home, '.claude', 'projects', claudeProjectSlug(workspacePath));
    for (const file of await listDir(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const text = await tryReadFile(join(projectDir, file));
      if (!text) continue;
      fold(parseClaudeTranscript(text, { from, to }));
    }
  } else {
    const sessionsRoot = join(home, '.codex', 'sessions');
    for (const dir of codexDateDirs(sessionsRoot, from ?? Date.now(), to ?? from ?? Date.now())) {
      for (const file of await listDir(dir)) {
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        const text = await tryReadFile(join(dir, file));
        if (!text) continue;
        // Rollouts are filed by date, not cwd — confirm the cwd before folding.
        const parsed = parseCodexRollout(text, { from, to });
        if (!cwdMatches(parsed.cwd, workspacePath)) continue;
        fold(parsed);
      }
    }
  }

  if (totals.sessions === 0) return null;
  totals.model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return totals;
}

/**
 * Measured counts for a completed run, or the caller's estimate when no
 * transcript can be attributed. Always resolves — a transcript read must never
 * fail the run it describes — and always returns a usable record, so a run with
 * no transcript still contributes its estimate rather than recording nothing.
 *
 * @param {object} run PortOS run metadata (`providerId`, `model`,
 *   `workspacePath`, `startTime`, `endTime`)
 * @param {{ tokensIn: number, tokensOut: number }} estimate fallback counts
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{ providerId: string|null, model: string|null, messages: number,
 *   tokensIn: number, tokensOut: number, cacheReadTokens: number,
 *   cacheWriteTokens: number, source: 'measured'|'estimate' }>}
 */
export async function reconcileRunUsage(run, estimate, { home = homedir() } = {}) {
  const fallback = {
    providerId: run?.providerId ?? null,
    model: run?.model ?? null,
    messages: 1,
    tokensIn: Math.max(0, estimate?.tokensIn || 0),
    tokensOut: Math.max(0, estimate?.tokensOut || 0),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: 'estimate'
  };

  const family = transcriptFamily({ providerId: run?.providerId, command: run?.command });
  if (!family) return fallback;

  // Best-effort: an unreadable home dir, a permissions error, or a CLI format
  // change must degrade to the estimate, never throw into the completion hook.
  const measured = await readMeasuredUsage({
    workspacePath: run?.workspacePath,
    startTime: run?.startTime,
    endTime: run?.endTime,
    family,
    home
  }).catch((err) => {
    console.error(`❌ Usage reconcile failed for ${run?.providerId}: ${err.message}`);
    return null;
  });
  if (!measured) return fallback;

  return {
    providerId: run?.providerId ?? null,
    // Prefer the model PortOS recorded (it carries the provider's own id shape,
    // e.g. a Bedrock-prefixed id the pricing table resolves); fall back to the
    // transcript's when PortOS captured none.
    model: run?.model ?? measured.model ?? null,
    messages: measured.messages || 1,
    tokensIn: measured.tokensIn,
    tokensOut: measured.tokensOut,
    cacheReadTokens: measured.cacheReadTokens,
    cacheWriteTokens: measured.cacheWriteTokens,
    source: 'measured'
  };
}

/**
 * The run-completion usage path, shared by the AI Toolkit hook
 * (`services/bootstrap.js`) and CoS agent runs
 * (`services/agentRunTracking.js`) so both record the same shape from the same
 * logic. Estimates tokens the legacy way, upgrades to the provider's measured
 * counts when a transcript can be found, and persists the result.
 *
 * Fire-and-forget by design — the callers invoke it from a completion hook, so
 * it owns its own error handling and never rejects into them. Runs with no
 * `providerId` are skipped rather than attributed to an `unknown` bucket.
 *
 * @param {object} metadata PortOS run metadata
 * @param {string} output captured stdout
 * @param {{ home?: string }} [opts] `home` overrides the transcript root (tests)
 * @returns {Promise<void>}
 */
export async function recordCompletedRunUsage(metadata, output, { home = homedir() } = {}) {
  if (!metadata?.providerId) return;

  const estimate = {
    tokensOut: estimateTokens(output),
    tokensIn: estimateTokensFromChars(metadata.promptLength)
  };
  // One catch for the whole chain: whatever fails — reading a transcript or
  // persisting the record — usage accounting must not surface as a run failure.
  await reconcileRunUsage(metadata, estimate, { home })
    .then(recordRunUsage)
    .catch((err) => {
      console.error(`❌ Failed to record usage: ${err.message}`);
    });
}

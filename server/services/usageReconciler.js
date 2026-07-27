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
import { isFreeModelId, resolveModelRates } from '../lib/modelPricing.js';
import {
  UNKNOWN_MODEL,
  claudeProjectSlug,
  parseClaudeTranscript,
  parseCodexRollout,
  totalTranscriptTokens
} from '../lib/providerTranscriptUsage.js';
import { recordRunUsage } from './usage.js';

// Widen the correlation window past the recorded run bounds: the CLI writes its
// first line slightly before PortOS stamps startTime, and flushes its last
// after the process exits. A minute of slack captures both.
//
// The slack does NOT make attribution exclusive: PortOS runs are NOT serialized
// per cwd (the runner allows several concurrent), and measured against this
// install's run history there are 39 genuinely overlapping same-cwd run pairs —
// 144 once this slack is applied. Two overlapping runs would each fold the whole
// overlap and double-bill it, so exclusivity is enforced separately by the
// per-message claim below, not by the window.
const WINDOW_SLACK_MS = 60_000;

// Messages already billed to a run, keyed `<transcript-key>:<message-key>`.
// A transcript message must be counted exactly ONCE across every run that can
// see it: without this, two concurrent runs in the same cwd (or one run whose
// window overlaps a neighbour's through WINDOW_SLACK_MS) each fold the same
// tokens and the cost report doubles. Process-local by design — it guards the
// live completion path, which is the only writer; a restart loses the ledger,
// but a run that already completed is never reconciled again.
const claimedMessages = new Set();

// The ABSOLUTE cumulative position of each Codex rollout that has already been
// billed, keyed by file path. Codex reports cumulative totals, so a rollout that
// grows between two runs would otherwise re-include the earlier run's tokens.
// Stored in absolute rollout units (not "tokens we billed") so the delta is a
// plain subtraction: a windowed parse already nets out the earlier snapshot, so
// mixing the two would double-subtract. Absolute totals are also immune to
// several snapshots sharing one epoch millisecond.
const codexHighWater = new Map();

/** Test-only: forget every claim so suites start from a clean ledger. */
export function __resetUsageClaims() {
  claimedMessages.clear();
  codexHighWater.clear();
}

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
 * Which model id to record for a measured bucket.
 *
 * PortOS's own id is preferable when the two AGREE, because it carries the
 * provider's shape (a Bedrock prefix, a `[1m]` suffix) that the transcript
 * strips but the pricing table resolves. It must NOT win when they disagree:
 * a run launched as `claude-opus-5` that actually fell back to a local
 * `qwen3.6:35b` would otherwise be priced at Opus rates instead of $0.
 *
 * "Agree" is tested by resolving both through the rate table — that treats
 * `global.anthropic.claude-opus-5[1m]` and `claude-opus-5` as the same model
 * (both resolve to `claude-opus-5`) while catching a genuine substitution.
 * A model-less bucket (`UNKNOWN_MODEL`) resolves to null so the caller prices it
 * at the provider default — EXCEPT when it is the run's only bucket, where the
 * recorded model is used instead. That case is a deliberate choice, not an
 * oversight: with one bucket and no name in the transcript, PortOS's launch-time
 * model is real evidence of what ran, while the provider default is a guess that
 * is often a different model entirely (a Bedrock Opus run defaults to Sonnet
 * rates — $3/$15 instead of $5/$25, understating the very cost this feature
 * exists to measure). With SEVERAL buckets the unnamed one can't be pinned to
 * the recorded model (some other bucket already holds it), so it stays null.
 */
function attributedModel(recordedModel, transcriptModel, singleModel) {
  const fromTranscript = transcriptModel === UNKNOWN_MODEL ? null : transcriptModel;
  if (!singleModel || !recordedModel) return fromTranscript;
  if (!fromTranscript) return recordedModel;
  if (recordedModel === fromTranscript) return recordedModel;
  // A local model can never be an alias of a hosted one — always trust the
  // transcript there, or free inference gets billed at the launch model's rate.
  if (isFreeModelId(fromTranscript) !== isFreeModelId(recordedModel)) return fromTranscript;
  const recordedRate = resolveModelRates(null, recordedModel).rateModel;
  const transcriptRate = resolveModelRates(null, fromTranscript).rateModel;
  // A null rateModel means "nothing in the table recognized this id", and two
  // unrecognized ids are NOT thereby the same model — treating null === null as
  // agreement would keep the launch-time id for a genuine substitution between
  // two unknown models. Require a resolved family to claim they match.
  const sameFamily = recordedRate != null && recordedRate === transcriptRate;
  return sameFamily ? recordedModel : fromTranscript;
}


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
  // Per-model token buckets across every folded session, so a run that switched
  // models is priced at each model's own rate rather than billing the whole
  // aggregate at the majority model.
  const byModel = new Map();

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
    for (const [model, bucket] of Object.entries(parsed.byModel || {})) {
      if (!byModel.has(model)) {
        byModel.set(model, { messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      }
      const target = byModel.get(model);
      target.messages += bucket.messages || 0;
      target.tokensIn += bucket.tokensIn || 0;
      target.tokensOut += bucket.tokensOut || 0;
      target.cacheReadTokens += bucket.cacheReadTokens || 0;
      target.cacheWriteTokens += bucket.cacheWriteTokens || 0;
    }
  };

  // Keys reserved by THIS call, so a failed/empty read can release them.
  const reserved = [];
  // Codex high-water marks advanced by this call, as [path, previousValue], so
  // an empty read restores the prior boundary instead of stranding it.
  const codexReserved = [];
  // Per-file view of the global ledger: a message key is only meaningful within
  // its own transcript, so scope the claim by file path to avoid a same-id
  // collision across two different sessions.
  const excludeFor = (fileKey) => {
    const prefix = `${fileKey}:`;
    return {
      has: (messageKey) => claimedMessages.has(prefix + messageKey)
    };
  };
  // Reserve IMMEDIATELY after each file is parsed, before the next `await`.
  // Deferring every claim to the end of the read would reopen the race the
  // ledger exists to close: this function awaits once per file, so two
  // overlapping runs could both parse file A, both see it unclaimed, and both
  // bill it. Reserving synchronously per file means the second run's read of
  // file A already sees the first run's claim.
  const reserveFrom = (fileKey, parsed) => {
    for (const key of parsed.countedKeys || []) {
      const claimKey = `${fileKey}:${key}`;
      claimedMessages.add(claimKey);
      reserved.push(claimKey);
    }
  };
  // Nothing was attributable after all — release so a later run can claim it.
  const releaseReserved = () => {
    for (const key of reserved) claimedMessages.delete(key);
    for (const [path, previous] of codexReserved) {
      if (previous == null) codexHighWater.delete(path);
      else codexHighWater.set(path, previous);
    }
  };

  if (family === 'claude') {
    // The project directory name is the slugified cwd — an exact lookup, with
    // no directory scan and no chance of picking up another repo's sessions.
    const projectDir = join(home, '.claude', 'projects', claudeProjectSlug(workspacePath));
    for (const file of await listDir(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(projectDir, file);
      const text = await tryReadFile(path);
      if (!text) continue;
      const parsed = parseClaudeTranscript(text, { from, to, exclude: excludeFor(path) });
      reserveFrom(path, parsed);
      fold(parsed);
    }
  } else {
    const sessionsRoot = join(home, '.codex', 'sessions');
    for (const dir of codexDateDirs(sessionsRoot, from ?? Date.now(), to ?? from ?? Date.now())) {
      for (const file of await listDir(dir)) {
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        const path = join(dir, file);
        const text = await tryReadFile(path);
        if (!text) continue;
        // A Codex rollout bills as a cumulative DELTA, so a timestamp claim is
        // not enough: a rollout that GROWS between two overlapping runs presents
        // a later snapshot under a different key, and its delta (measured from a
        // baseline before both runs) re-includes what the first run already
        // billed. Track the highest cumulative boundary billed per file and
        // re-parse from there, so each run charges only the genuinely new part.
        // Read the rollout's ABSOLUTE cumulative position (no window), then bill
        // the difference from what was already charged. The watermark must be in
        // absolute rollout units, not "tokens billed": a windowed parse already
        // excludes the earlier snapshot as its baseline, so subtracting the
        // billed amount from an already-delta'd figure double-subtracts (measured:
        // a later run billed 50 instead of 150). Absolute totals also make the
        // arithmetic immune to several snapshots sharing one epoch millisecond,
        // which is why the timestamp boundary this replaced was unsound.
        const absolute = parseCodexRollout(text);
        if (!cwdMatches(absolute.cwd, workspacePath)) continue;
        // Still require the run's own window to overlap this rollout at all, so a
        // rollout from an unrelated period isn't attributed to this run.
        if (totalTranscriptTokens(parseCodexRollout(text, { from, to })) === 0) continue;

        const billed = codexHighWater.get(path);
        const delta = (field) => Math.max(0, (absolute[field] || 0) - (billed?.[field] || 0));
        const net = {
          ...absolute,
          messages: delta('messages'),
          tokensIn: delta('tokensIn'),
          tokensOut: delta('tokensOut'),
          cacheReadTokens: delta('cacheReadTokens'),
          cacheWriteTokens: delta('cacheWriteTokens')
        };
        if (totalTranscriptTokens(net) === 0) continue;

        // Advance the mark to the absolute position just read, before the next
        // `await` — for the same reason the Claude claim reserves per file: two
        // overlapping runs must not both act on the pre-update value. `Math.max`
        // guards a rollout that was truncated/rewritten smaller, so the mark
        // never moves backwards and re-bills what it already charged.
        codexHighWater.set(path, {
          messages: Math.max(billed?.messages || 0, absolute.messages || 0),
          tokensIn: Math.max(billed?.tokensIn || 0, absolute.tokensIn || 0),
          tokensOut: Math.max(billed?.tokensOut || 0, absolute.tokensOut || 0),
          cacheReadTokens: Math.max(billed?.cacheReadTokens || 0, absolute.cacheReadTokens || 0),
          cacheWriteTokens: Math.max(billed?.cacheWriteTokens || 0, absolute.cacheWriteTokens || 0)
        });
        codexReserved.push([path, billed]);
        // Mirror the net into `byModel` — callers bill from the per-model records,
        // so leaving them at absolute totals would re-charge the billed portion.
        // Codex reports one model per rollout, so the whole net is that model's.
        const modelKey = Object.keys(absolute.byModel || {})[0];
        fold(modelKey
          ? { ...net, byModel: { [modelKey]: {
              messages: net.messages,
              tokensIn: net.tokensIn,
              tokensOut: net.tokensOut,
              cacheReadTokens: net.cacheReadTokens,
              cacheWriteTokens: net.cacheWriteTokens
            } } }
          : net);
      }
    }
  }

  if (totals.sessions === 0) {
    releaseReserved();
    return null;
  }
  totals.model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  totals.byModel = Object.fromEntries(byModel);
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
 * Returns a single record, or an ARRAY of them when the transcript names more
 * than one model (a mid-run `/model` switch or a fallback) — `recordRunUsage`
 * accepts either, and splitting is what keeps each model priced at its own rate.
 *
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{ providerId: string|null, model: string|null, messages: number,
 *   tokensIn: number, tokensOut: number, cacheReadTokens: number,
 *   cacheWriteTokens: number, source: 'measured'|'estimate' }
 *   | Array<object>>}
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

  // A session can switch models mid-run, so split the record per model the
  // transcript actually names — billing every token at the launch-time model
  // would price a run that started on Opus and finished on Haiku entirely at
  // Opus rates. `byModel` is authoritative when present; fall back to one
  // aggregate record when the transcript named no model at all.
  const perModel = Object.entries(measured.byModel || {});
  if (perModel.length > 0) {
    return perModel.map(([model, bucket]) => ({
      providerId: run?.providerId ?? null,
      model: attributedModel(run?.model ?? null, model, perModel.length === 1),
      messages: bucket.messages || 0,
      tokensIn: bucket.tokensIn,
      tokensOut: bucket.tokensOut,
      cacheReadTokens: bucket.cacheReadTokens,
      cacheWriteTokens: bucket.cacheWriteTokens,
      source: 'measured'
    }));
  }

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

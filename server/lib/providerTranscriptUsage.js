/**
 * Parsers for the per-message token counts the coding CLIs already write to
 * disk. PortOS's own accounting (`services/usage.js`) can only *estimate*
 * tokens — output from captured stdout (a repainted screen for TUI providers)
 * and input from the initial prompt length, which misses the per-turn context
 * replay and prompt-cache traffic that dominate real API cost. These files are
 * ground truth, cost 0 tokens to read, and are written by the CLI itself:
 *
 *   Claude Code — ~/.claude/projects/<cwd-slug>/<session>.jsonl
 *     One JSON object per line. Assistant lines carry
 *     `message.usage = { input_tokens, cache_creation_input_tokens,
 *     cache_read_input_tokens, output_tokens }` plus `message.model`; most
 *     lines also carry `cwd`, `sessionId`, and `timestamp`.
 *
 *   Codex — ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *     Line 1 is a `session_meta` payload with `id`/`cwd`/`cli_version`. Later
 *     `event_msg`/`token_count` lines carry a CUMULATIVE `total_token_usage`
 *     plus the per-turn `last_token_usage`.
 *
 * Both formats have a de-duplication hazard that makes naive summing wrong by
 * a large factor, documented at each parser. Both parsers are pure (text in,
 * totals out), tolerant of truncated trailing lines (a session still being
 * written), and ignore unknown fields so a CLI update can't break them.
 */

/**
 * Slugify a working directory the way Claude Code names its project folder:
 * every `/` and `.` becomes `-`. An absolute POSIX path therefore keeps its
 * leading `-` (`/Users/x/repo` → `-Users-x-repo`), which is what the CLI does.
 * @param {string} cwd
 * @returns {string}
 */
export function claudeProjectSlug(cwd) {
  return String(cwd || '').replace(/[/.]/g, '-');
}

/**
 * Parse newline-delimited JSON, skipping blank lines and any line that doesn't
 * parse. A partially-flushed final line is the common case for a session still
 * being appended to, so an unparseable line is normal input, not an error.
 * @param {string} text
 * @returns {object[]}
 */
function parseJsonLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A truncated mid-write line is expected — skip it rather than throw.
    // (JSON.parse has no non-throwing form, so this try/catch is the parse.)
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

const emptyTotals = () => ({
  messages: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
});

/** ISO timestamp → epoch ms, or null when absent/unparseable. */
const toEpoch = (value) => {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * True when `ts` falls inside `[from, to]`. A null bound is open; a null `ts`
 * is treated as inside the window — a line whose timestamp we can't read is
 * better attributed to the run we're reconciling (the file was located by cwd
 * slug) than silently dropped, which would under-count.
 */
const inWindow = (ts, from, to) => {
  if (ts == null) return true;
  if (from != null && ts < from) return false;
  if (to != null && ts > to) return false;
  return true;
};

/**
 * Parse a Claude Code session transcript.
 *
 * **De-duplication is load-bearing.** One API response is written to the
 * transcript as SEVERAL lines that share the same `message.id`, `requestId`,
 * and an identical `message.usage` — the CLI re-emits the assistant record as
 * it streams/annotates content blocks. On a measured session, 1,734 assistant
 * lines represented only 740 distinct responses, so summing per line inflates
 * every token count (and therefore the cost) by ~2.3×. We count each
 * `message.id` exactly once. Lines with no id fall back to their own `uuid`
 * so they still count once rather than being dropped.
 *
 * Sub-agent (`isSidechain`) messages ARE counted: their tokens are billed to
 * the same account, and PortOS records one run per parent invocation.
 *
 * @param {string} jsonlText raw file contents (may end mid-line)
 * @param {{ from?: number|null, to?: number|null }} [window] epoch-ms bounds;
 *   assistant messages outside the window are excluded (used to attribute a
 *   long-lived CLI session to one PortOS run).
 * @returns {{ sessionId: string|null, cwd: string|null, model: string|null,
 *   models: string[], messages: number, tokensIn: number, tokensOut: number,
 *   cacheReadTokens: number, cacheWriteTokens: number,
 *   firstTs: string|null, lastTs: string|null }}
 */
export function parseClaudeTranscript(jsonlText, { from = null, to = null } = {}) {
  const totals = emptyTotals();
  const seen = new Set();
  const modelCounts = new Map();
  let sessionId = null;
  let cwd = null;
  let firstTs = null;
  let lastTs = null;

  for (const entry of parseJsonLines(jsonlText)) {
    if (!sessionId && typeof entry.sessionId === 'string') sessionId = entry.sessionId;
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;

    const usage = entry.type === 'assistant' ? entry.message?.usage : null;
    if (!usage || typeof usage !== 'object') continue;

    const ts = toEpoch(entry.timestamp);
    if (!inWindow(ts, from, to)) continue;

    // One response spans multiple lines with identical usage — count it once.
    const dedupeKey = entry.message?.id || entry.uuid;
    if (dedupeKey) {
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }

    totals.messages += 1;
    totals.tokensIn += num(usage.input_tokens);
    totals.tokensOut += num(usage.output_tokens);
    totals.cacheReadTokens += num(usage.cache_read_input_tokens);
    totals.cacheWriteTokens += num(usage.cache_creation_input_tokens);

    const model = typeof entry.message?.model === 'string' ? entry.message.model : null;
    if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1);

    if (typeof entry.timestamp === 'string' && entry.timestamp) {
      if (!firstTs || entry.timestamp < firstTs) firstTs = entry.timestamp;
      if (!lastTs || entry.timestamp > lastTs) lastTs = entry.timestamp;
    }
  }

  // A session can switch models mid-run (/model, or a fallback). Report every
  // model seen, plus the most-used one as the single `model` attribution.
  const models = [...modelCounts.keys()];
  const model = models.length
    ? [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;

  return { sessionId, cwd, model, models, ...totals, firstTs, lastTs };
}

/**
 * Parse a Codex rollout transcript.
 *
 * **`total_token_usage` is cumulative, and its events repeat.** Every
 * `event_msg`/`token_count` line restates the running total for the whole
 * session, and consecutive lines commonly repeat an unchanged total. So
 * neither summing `total_token_usage` (which would multiply the session by its
 * event count) nor summing `last_token_usage` (which double-counts, because a
 * repeated event repeats its `last` block too) is correct. We take the LAST
 * total in range — the cumulative figure already is the session sum.
 *
 * `input_tokens` is the *total* input including the cached portion, so the
 * uncached input we bill at the standard rate is `input - cached`, with
 * `cached` priced at the provider's cached-input rate. Codex reports no
 * cache-write tier, so `cacheWriteTokens` is always 0. `reasoning_output_tokens`
 * is a subset of `output_tokens` (already billed as output), not an addition.
 *
 * When a window is supplied and no in-range event exists but earlier events do,
 * the delta from the last pre-window total is used, so a rollout spanning two
 * PortOS runs attributes each run only its own increment.
 *
 * @param {string} jsonlText raw file contents (may end mid-line)
 * @param {{ from?: number|null, to?: number|null }} [window] epoch-ms bounds
 * @returns {{ sessionId: string|null, cwd: string|null, model: string|null,
 *   models: string[], messages: number, tokensIn: number, tokensOut: number,
 *   cacheReadTokens: number, cacheWriteTokens: number,
 *   firstTs: string|null, lastTs: string|null }}
 */
export function parseCodexRollout(jsonlText, { from = null, to = null } = {}) {
  let sessionId = null;
  let cwd = null;
  let model = null;
  let messages = 0;
  let firstTs = null;
  let lastTs = null;
  // Cumulative snapshots: the last one before the window start is the
  // baseline; the last one inside the window is the end state.
  let baseline = null;
  let latest = null;

  for (const entry of parseJsonLines(jsonlText)) {
    const payload = entry.payload;
    if (entry.type === 'session_meta' && payload && typeof payload === 'object') {
      if (typeof payload.id === 'string') sessionId ??= payload.id;
      if (typeof payload.cwd === 'string') cwd ??= payload.cwd;
      if (typeof payload.model === 'string') model ??= payload.model;
      continue;
    }
    // The model can also arrive on a per-turn context record.
    if (entry.type === 'turn_context' && typeof payload?.model === 'string') {
      model ??= payload.model;
    }
    if (payload?.type === 'agent_message') messages += 1;
    if (payload?.type !== 'token_count') continue;

    const total = payload.info?.total_token_usage;
    if (!total || typeof total !== 'object') continue;

    const ts = toEpoch(entry.timestamp);
    if (from != null && ts != null && ts < from) {
      baseline = total; // pre-window state — subtract it below
      continue;
    }
    if (to != null && ts != null && ts > to) continue;

    latest = total;
    if (typeof entry.timestamp === 'string' && entry.timestamp) {
      if (!firstTs || entry.timestamp < firstTs) firstTs = entry.timestamp;
      if (!lastTs || entry.timestamp > lastTs) lastTs = entry.timestamp;
    }
  }

  if (!latest) {
    return { sessionId, cwd, model, models: model ? [model] : [], ...emptyTotals(), firstTs, lastTs };
  }

  // Cumulative delta against the pre-window baseline (0 when unwindowed).
  const delta = (key) => Math.max(0, num(latest[key]) - num(baseline?.[key]));
  const cachedIn = delta('cached_input_tokens');
  const totalIn = delta('input_tokens');

  return {
    sessionId,
    cwd,
    model,
    models: model ? [model] : [],
    // Codex reports no per-message split; a rollout is one recorded exchange
    // when it produced any assistant message.
    messages: messages || 1,
    // `input_tokens` INCLUDES the cached portion — split it so each tier is
    // priced at its own rate instead of billing cache reads as fresh input.
    tokensIn: Math.max(0, totalIn - cachedIn),
    tokensOut: delta('output_tokens'),
    cacheReadTokens: cachedIn,
    cacheWriteTokens: 0,
    firstTs,
    lastTs
  };
}

/**
 * Sum of every billable token bucket — the "did we measure anything" test used
 * by the reconciler to decide between a measured record and the estimate.
 * @param {{ tokensIn?: number, tokensOut?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} totals
 * @returns {number}
 */
export function totalTranscriptTokens(totals) {
  return num(totals?.tokensIn) + num(totals?.tokensOut)
    + num(totals?.cacheReadTokens) + num(totals?.cacheWriteTokens);
}

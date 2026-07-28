/**
 * Status lines PortOS writes INTO an agent's output buffer.
 *
 * A TUI agent's `output.txt` is not a transcript — the live PTY stream goes to
 * `raw.txt` and the Shell tab. What lands in `output.txt` is a mix of two very
 * different things:
 *   1. lifecycle telemetry PortOS itself appends (`📟 TUI session started…`,
 *      `💡 Open the Shell tab…`, `⚠️ Paste verification failed…`), and
 *   2. the agent's own `.agent-done` summary, ingested behind
 *      `SENTINEL_COMPLETION_MARKER` when the run finalizes.
 *
 * Downstream consumers that present the agent's words to a human — most
 * importantly the generated PR description — must keep (2) and drop (1).
 * Both live here, pure and dependency-free, so the emitter
 * (`services/agentTuiSpawning.js`) and the readers can't drift apart: a marker
 * reworded on one side but not the other silently reverts the noise.
 */

/** Line `ingestDoneSentinel` appends immediately before the sentinel summary. */
export const SENTINEL_COMPLETION_MARKER = '✅ Agent signaled completion';

/**
 * The PortOS-authored lifecycle status lines, matched on their actual message
 * shapes — deliberately NOT "any line starting with an emoji."
 *
 * The agent's own summary is markdown, but nothing stops it from writing a
 * checklist line like `✅ Tests passed` or `⚠️ Known limitation: …` with no
 * leading `-`. A bare emoji-prefix test would classify those as telemetry and
 * silently delete them from the PR description — and a summary made mostly of
 * such lines could shrink under `extractAgentSummary`'s minimum length and fall
 * all the way back to commit messages. Anchoring on the message text means only
 * lines PortOS actually emits can match.
 *
 * Kept in sync with `appendLine` in `services/agentTuiSpawning.js`. Not listed:
 * the generic `❌ <summary>` from `finishStartupFailure`, whose text comes from
 * its caller and so has no fixed shape to anchor on — it only fires on a startup
 * failure, which finalizes the agent unsuccessfully and never opens a PR.
 */
const LIFECYCLE_LINE_PATTERNS = [
  /^\s*📟 TUI session started: /u,
  /^\s*📟 Prompt pasted into TUI session /u,
  /^\s*📟 Auto-confirmed .+ folder-trust prompt for session /u,
  /^\s*💡 Open the Shell tab /u,
  /^\s*⚡ Provider fallback signal: /u,
  /^\s*⏳ Max runtime reached — /u,
  /^\s*⚠️?\s*Paste verification failed /u,
  /^\s*❌ Paste (?:never landed|verification failed) /u,
];

/**
 * Is this line PortOS lifecycle telemetry rather than something the agent said?
 * @param {string} line
 * @returns {boolean}
 */
export function isAgentLifecycleLine(line) {
  return LIFECYCLE_LINE_PATTERNS.some(re => re.test(line));
}

/**
 * Drop PortOS lifecycle status lines from an array of output lines.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function stripLifecycleLines(lines) {
  return lines.filter(line => !isAgentLifecycleLine(line));
}

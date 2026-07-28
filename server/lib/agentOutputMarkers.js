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
 * Matches a PortOS-authored lifecycle status line. These are all emitted via the
 * output spooler's `appendLine` with a leading emoji + space — a shape the agent's
 * own summary essentially never takes, since it writes markdown (a bullet leads
 * with `-`, a heading with `#`). Base codepoints with an optional VS16 (`️`),
 * because the emitters are inconsistent about the variation selector (`⚠️` carries
 * one, `⚡` does not) and a literal-only match would miss half of them.
 */
export const RE_AGENT_LIFECYCLE_LINE = /^\s*(?:📟|💡|⚡|⏳|⚠|❌|✅|🌳)️?\s/u;

/**
 * Drop PortOS lifecycle status lines from an array of output lines.
 * @param {string[]} lines
 * @returns {string[]}
 */
export function stripLifecycleLines(lines) {
  return lines.filter(line => !RE_AGENT_LIFECYCLE_LINE.test(line));
}

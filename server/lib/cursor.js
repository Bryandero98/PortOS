/**
 * Per-CLI conventions for Cursor's agentic coding CLI (binary: `cursor-agent`).
 *
 * Cursor ships two PortOS process-provider shapes:
 *   - `cursor-cli`  (type `cli`) — headless one-shot via `cursor-agent --print`.
 *   - `cursor-tui`  (type `tui`) — the interactive Cursor Agent TUI over a PTY.
 *
 * Prompt delivery (headless): `cursor-agent --print` reads the prompt from raw
 * stdin when no trailing prompt argument is given — the same convention as
 * claude/codex — so the shared `prepareCliPrompt` dispatcher needs no cursor
 * branch and the existing `stdin.write(prompt)` at every spawn site feeds it
 * unchanged. (Verified against cursor-agent 2026.08.04: `echo … | cursor-agent
 * -p --force` returns the reply on stdout and exits 0.)
 *
 * Workspace trust: cursor-agent refuses to run in a directory it has not been
 * told to trust, printing a "Workspace Trust Required" block and exiting instead
 * of doing any work — fatal for a headless agent, which has no one to answer it.
 * `--force` satisfies that gate (the binary's own message names `--trust`,
 * `--yolo`, or `-f`) AND auto-approves tool calls, so it is the single flag that
 * covers both, mirroring claude's `--dangerously-skip-permissions` / codex's
 * `--dangerously-bypass-approvals-and-sandbox` / kimi's `--yolo`.
 *
 * Output format: PortOS runs cursor in its default PLAIN TEXT mode, so the
 * live-output handler falls through to its default text path (like
 * grok/kimi/opencode). cursor-agent does offer `--output-format stream-json`
 * whose frames closely resemble Claude Code's, but its assistant text arrives on
 * `type: "assistant"` message frames rather than the `stream_event` /
 * `content_block_delta` frames `createStreamJsonParser` extracts live text from —
 * so selecting it today would yield a final result with no streaming output.
 * Teaching the parser that dialect is tracked separately.
 *
 * Model selection: unlike Grok/Kimi/Antigravity, cursor needs NO configured-
 * default sentinel — it exposes a real `auto` model id (its own server-side
 * router, and the binary's own default), so `auto` is stored as `defaultModel`
 * and passed through as a normal `--model auto`. Effort is baked into the model
 * ids themselves (`…-low` / `…-high` / `…-xhigh` / `…-max`) rather than exposed
 * as a flag, so cursor has no `--effort` control and `effortLevelsForProvider`
 * correctly reports none for it.
 *
 * Dependency-light on purpose: imports only `providerModels.js` helpers,
 * mirroring `grok.js`/`kimi.js`/`antigravity.js` so it stays importable from the
 * standalone autofixer.
 */

import { argvHasFlag, commandBasename, hasModelFlag } from './providerModels.js';

/** The binary basename. Deliberately NOT `cursor` — that is the GUI editor. */
export const CURSOR_COMMAND = 'cursor-agent';

/**
 * True when a provider command points at the Cursor Agent binary — the bare
 * `cursor-agent` on PATH, an absolute/relative path to it, or an optional
 * Windows `.exe` suffix (same matching rules as `isGrokCommand`/`isKimiCommand`).
 *
 * Matches ONLY `cursor-agent`, never a bare `cursor`: that is Cursor's GUI
 * editor launcher, and spawning it from a headless agent would open a window
 * (or hang) rather than run the coding agent.
 * @param {string|null|undefined} command
 * @returns {boolean}
 */
export function isCursorCommand(command) {
  return commandBasename(command) === CURSOR_COMMAND;
}

// `--print` (`-p`) puts cursor-agent in non-interactive print mode.
const PRINT_FLAGS = ['--print', '-p'];
// Approval/trust postures. `--force`/`-f`/`--yolo` run everything unprompted and
// also satisfy the workspace-trust gate; `--auto-review` is the server-classifier
// middle ground; `--trust` clears trust only. Any one present means the user
// pinned their own posture — don't add another.
const APPROVAL_FLAGS = ['--force', '-f', '--yolo', '--auto-review', '--trust'];

/**
 * Build the headless (one-shot) argv for the Cursor Agent CLI. Ensures, when not
 * already pinned by the user's saved `args`:
 *   - `--print`      — non-interactive print mode (prompt read from stdin).
 *   - `--force`      — clears the workspace-trust gate AND auto-approves tool
 *                      calls, so an unattended run neither exits on the trust
 *                      block nor stalls on an approval prompt.
 *   - `--model <id>` — gated on `model` being set AND no user-baked model flag.
 * The prompt itself is NOT added here — it rides on stdin at spawn time.
 * @param {string[]} baseArgs - user/legacy args (already model-flag-sanitized)
 * @param {string|null|undefined} model - defaultModel to pin, or null to omit
 * @returns {string[]}
 */
export function ensureCursorHeadlessArgs(baseArgs = [], model) {
  const out = [...baseArgs];
  if (!argvHasFlag(out, PRINT_FLAGS)) {
    out.push('--print');
  }
  if (!argvHasFlag(out, APPROVAL_FLAGS)) {
    out.push('--force');
  }
  if (model && !hasModelFlag(out)) {
    out.push('--model', model);
  }
  return out;
}

/**
 * Ensure the interactive Cursor TUI argv clears the workspace-trust gate and
 * auto-approves tool executions, so a file-writing agent is neither refused at
 * startup nor stranded on an approval prompt (mirrors the codex
 * `--dangerously-bypass-approvals-and-sandbox` / claude-code-tui
 * `--dangerously-skip-permissions` / kimi `--yolo` TUI defaults). Idempotent
 * when the user already pinned a trust/approval posture.
 * @param {string[]} args
 * @returns {string[]}
 */
export function ensureCursorTuiArgs(args = []) {
  const out = [...args];
  if (!argvHasFlag(out, APPROVAL_FLAGS)) {
    out.push('--force');
  }
  return out;
}

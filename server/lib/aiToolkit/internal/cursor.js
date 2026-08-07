/**
 * Cursor Agent constants and catalog parsing for the aiToolkit.
 *
 * `CURSOR_COMMAND` and `isCursorCommand` are duplicated from
 * server/lib/cursor.js so the toolkit stays self-contained (no imports out to
 * sibling PortOS modules — see ../CLAUDE.md); keep those two in sync with
 * upstream, the same arrangement as ./antigravity.js.
 *
 * `CURSOR_TUI_ID`, `CURSOR_MODEL_LINE` and `parseCursorModelList` are
 * toolkit-native and have NO upstream counterpart — server/lib/cursor.js owns
 * argv construction, not model-catalog parsing, and should not grow a copy of
 * this. A sync pass should not go looking for one.
 */

import { commandBasename } from './commandBasename.js';

export const CURSOR_TUI_ID = 'cursor-tui';

/** The binary basename. Deliberately NOT `cursor` — that is the GUI editor. */
export const CURSOR_COMMAND = 'cursor-agent';

// Match by normalized binary basename so a path- or `.exe`-configured provider
// (`~/.local/bin/cursor-agent`, `cursor-agent.exe`) is still recognized. Keep in
// sync with server/lib/cursor.js#isCursorCommand.
export function isCursorCommand(command) {
  return commandBasename(command) === CURSOR_COMMAND;
}

// `cursor-agent models` prints `<id> - <Label>` rows wrapped in a header line
// and a trailing `Tip:` paragraph:
//
//   Available models
//
//   auto - Auto (current, default)
//   gpt-5.3-codex-low - Codex 5.3 Low
//   …
//
//   Tip: use --model <id> (or /model <id> in interactive mode) to switch. …
//
// so it needs its own parser rather than `agy models`' bare-id-per-line one.
//
// Anchoring on the ` - ` separator is what separates a row from the surrounding
// prose: an id is a single space-free lowercase token, so neither "Available
// models" nor the `Tip:` sentence can present one immediately before a
// space-dash-space. (Verified against cursor-agent 2026.08.04: all 177 reported
// ids draw from `[a-z0-9.-]`, and those two prose lines are the only non-blank
// output the regex has to reject.) `.+` after the separator is greedy but the id
// group cannot contain a space, so a LABEL carrying its own ` - ` still yields
// the id alone.
const CURSOR_MODEL_LINE = /^([a-z0-9][a-z0-9._:/-]*) - .+$/;

/**
 * Parse the id column out of `cursor-agent models` output.
 * @param {string} stdout - raw stdout from `cursor-agent models`
 * @returns {string[]} deduped ids, in the order the binary listed them
 */
export function parseCursorModelList(stdout) {
  const ids = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = CURSOR_MODEL_LINE.exec(line.trim());
    if (match) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

/**
 * Antigravity provider constants and argument helpers for the aiToolkit.
 *
 * Duplicated from server/lib/antigravity.js so the toolkit stays self-contained
 * (no imports out to sibling PortOS modules). Keep in sync with upstream.
 */

import { commandBasename } from './commandBasename.js';

export const ANTIGRAVITY_CLI_ID = 'antigravity-cli';
export const ANTIGRAVITY_TUI_ID = 'antigravity-tui';
export const LEGACY_GEMINI_CLI_ID = 'gemini-cli';
export const LEGACY_GEMINI_TUI_ID = 'gemini-tui';
export const ANTIGRAVITY_CONFIGURED_DEFAULT = 'antigravity-configured-default';

// Match by normalized binary basename so a path- or `.exe`-configured provider
// (`/opt/homebrew/bin/agy`, `agy.exe`) is still recognized. Uses the toolkit's
// own ./commandBasename.js rather than the shared server/lib one, to keep the
// vendored toolkit self-contained. Keep in sync with
// server/lib/antigravity.js#isAntigravityCommand.
export function isAntigravityCommand(command) {
  const base = commandBasename(command);
  return base === 'agy' || base === 'antigravity';
}

// `agy models` prints one row per model on stdout (its "Fetching available
// models…" banner goes to stderr, so it never reaches this parser). Older
// builds printed a bare id per line; agy 2026-08 prints `<id>\t<Label>`:
//
//   gemini-3.6-flash-high\tGemini 3.6 Flash (High)
//   claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
//
// Both shapes are accepted — other installs run older agy builds, and a
// whole-line id match is what every previously-persisted catalog was parsed
// with. The label is anchored on a TAB rather than "first whitespace token" on
// purpose: a prose line ("Available models") would otherwise surrender a
// regex-valid first word and get persisted as a model id.
//
// Lives here so it sits next to ./cursor.js#parseCursorModelList and gets
// direct unit coverage, rather than being reachable only by spawning a fake
// binary through the provider service. Mirrored upstream at
// server/lib/antigravity.js#parseAntigravityModelList (PortOS's image-gen agy
// provider needs the same parse and cannot import into this directory's
// `internal/`) — keep the two in sync.
const ANTIGRAVITY_MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?:\t.*)?$/;

/**
 * Parse the ids out of `agy models` output, dropping blanks, banner/status
 * prose, and the configured-default sentinel (which the caller re-prepends).
 * @param {string} stdout - raw stdout from `agy models`
 * @returns {string[]} deduped ids, in the order the binary listed them
 */
export function parseAntigravityModelList(stdout) {
  const ids = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = ANTIGRAVITY_MODEL_LINE.exec(line.trim());
    if (match && match[1] !== ANTIGRAVITY_CONFIGURED_DEFAULT) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export function isAntigravityCliProvider(provider) {
  return provider?.id === ANTIGRAVITY_CLI_ID || isAntigravityCommand(provider?.command);
}

// `--yolo` is a Gemini-CLI flag agy never accepted, and `-m` /
// `--output-format` / `-o` are legacy Gemini-CLI spellings agy still rejects (it
// takes the long `--model` only, and has no output-format flag). The LONG
// `--model` is deliberately NOT stripped — agy documents it as a per-session
// flag, so a user-baked pin is a real selection to preserve. Keep in sync with
// server/lib/antigravity.js#stripAntigravityUnsupportedArgs.
export function stripAntigravityUnsupportedArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--yolo') continue;
    if (arg === '-m' || arg === '--output-format' || arg === '-o') {
      i += 1;
      continue;
    }
    if (
      typeof arg === 'string'
      && (arg.startsWith('-m=') || arg.startsWith('--output-format=') || arg.startsWith('-o='))
    ) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

// `agy --print`/`-p`/`--prompt` takes the prompt as the flag's VALUE and does
// NOT read stdin. So the print flag must be the FINAL token (a marker); the host
// runner splices the prompt in right after it at spawn time. Keep in sync with
// server/lib/antigravity.js#ensureAntigravityPrintArgs — the host overrides the
// runner (setCliRunner), so the prompt injection itself lives host-side — as
// does per-run `--model` / `--effort` injection (it needs the shared
// providerModels helpers this vendored copy must not import). These two
// builders are only used by the legacy-Gemini→agy provider migration, which has
// no per-run model to thread.
const ANTIGRAVITY_PRINT_FLAGS = ['--print', '-p', '--prompt'];

export function ensureAntigravityPrintArgs(args = []) {
  const out = stripAntigravityUnsupportedArgs(args).filter((arg) => !ANTIGRAVITY_PRINT_FLAGS.includes(arg));
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  out.push('--print');
  return out;
}

export function ensureAntigravityTuiArgs(args = []) {
  const out = stripAntigravityUnsupportedArgs(args);
  if (!out.includes('--dangerously-skip-permissions') && !out.includes('--sandbox')) {
    out.push('--dangerously-skip-permissions');
  }
  return out;
}

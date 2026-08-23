import { describe, it, expect } from 'vitest';
import { CURSOR_COMMAND, CURSOR_TUI_ID, isCursorCommand, parseCursorModelList } from './cursor.js';
// The toolkit SOURCE may not import out to server/lib (see ../AGENTS.md); a test
// may, and this is the only way to actually pin the duplication it documents.
import { CURSOR_COMMAND as UPSTREAM_COMMAND, isCursorCommand as upstreamIsCursorCommand } from '../../cursor.js';

// A verbatim excerpt of `cursor-agent models` (2026.08.04) — the header line,
// the blank line under it, a run of `<id> - <Label>` rows, and the trailing
// `Tip:` paragraph. Trimmed from the real 177-row catalog; the surrounding
// prose and spacing are reproduced exactly, because rejecting it is the whole
// job of the parser.
const REAL_OUTPUT = `Available models

auto - Auto (current, default)
gpt-5.3-codex-low - Codex 5.3 Low
gpt-5.3-codex-low-fast - Codex 5.3 Low Fast
composer-2.5 - Composer 2.5
claude-opus-5-thinking-high - Opus 5 1M Thinking
claude-fable-5-thinking-high - Fable 5 1M Thinking (NO ZDR)
gemini-3.5-flash - Gemini 3.5 Flash
gpt-5-mini - GPT-5 Mini

Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.
`;

describe('isCursorCommand', () => {
  it('matches the bare binary, an absolute path, and a Windows .exe', () => {
    expect(isCursorCommand('cursor-agent')).toBe(true);
    expect(isCursorCommand('/opt/homebrew/bin/cursor-agent')).toBe(true);
    expect(isCursorCommand('C:\\Tools\\cursor-agent.exe')).toBe(true);
    expect(isCursorCommand('CURSOR-AGENT')).toBe(true);
  });

  it('never matches a bare `cursor` — that is the GUI editor launcher', () => {
    // Spawning the editor from a headless refresh would open a window or hang
    // rather than print a catalog, so this must stay a non-match.
    expect(isCursorCommand('cursor')).toBe(false);
    expect(isCursorCommand('/usr/local/bin/cursor')).toBe(false);
  });

  it('rejects empty and non-string commands', () => {
    expect(isCursorCommand('')).toBe(false);
    expect(isCursorCommand(null)).toBe(false);
    expect(isCursorCommand(undefined)).toBe(false);
    expect(isCursorCommand(42)).toBe(false);
  });
});

describe('parseCursorModelList', () => {
  it('extracts ids from real `cursor-agent models` output, dropping the prose', () => {
    expect(parseCursorModelList(REAL_OUTPUT)).toEqual([
      'auto',
      'gpt-5.3-codex-low',
      'gpt-5.3-codex-low-fast',
      'composer-2.5',
      'claude-opus-5-thinking-high',
      'claude-fable-5-thinking-high',
      'gemini-3.5-flash',
      'gpt-5-mini',
    ]);
  });

  it('drops the header and the trailing Tip paragraph specifically', () => {
    const ids = parseCursorModelList(REAL_OUTPUT);
    expect(ids).not.toContain('Available');
    expect(ids).not.toContain('Tip:');
    expect(ids.some(id => id.includes(' '))).toBe(false);
  });

  it('keeps `auto` — cursor has a real router id, not a synthetic sentinel', () => {
    // Unlike Grok/Kimi/Antigravity, cursor needs no `*-configured-default`
    // sentinel: `auto` is a genuine id the binary accepts, so it must survive
    // a refresh as an ordinary catalog entry or "let cursor choose" disappears.
    expect(parseCursorModelList(REAL_OUTPUT)[0]).toBe('auto');
  });

  it('stops the id at the first separator when the LABEL also contains " - "', () => {
    expect(parseCursorModelList('gpt-5.3-codex - Codex 5.3 - Priority Compute')).toEqual(['gpt-5.3-codex']);
  });

  it('handles CRLF line endings', () => {
    expect(parseCursorModelList('Available models\r\n\r\nauto - Auto\r\ncomposer-2.5 - Composer 2.5\r\n'))
      .toEqual(['auto', 'composer-2.5']);
  });

  it('tolerates indented rows and dedupes repeats, preserving first-seen order', () => {
    expect(parseCursorModelList('  auto - Auto\ncomposer-2.5 - Composer\n  auto - Auto\n'))
      .toEqual(['auto', 'composer-2.5']);
  });

  it('returns an empty list for prose-only, blank, and non-string input', () => {
    // The caller turns empty into a THROW, so this must not invent entries from
    // a banner-only response (e.g. an auth prompt printed in place of a list).
    expect(parseCursorModelList('Available models\n\nTip: use --model <id>\n')).toEqual([]);
    expect(parseCursorModelList('Please log in first.\n')).toEqual([]);
    expect(parseCursorModelList('')).toEqual([]);
    expect(parseCursorModelList(null)).toEqual([]);
    expect(parseCursorModelList(undefined)).toEqual([]);
  });
});

describe('vendored copy stays in sync with server/lib/cursor.js', () => {
  // The file header promises these two track upstream. Assert it rather than
  // asserting each constant equals its own literal, which only re-states the
  // source and would stay green through exactly the drift that matters.
  it('agrees with upstream on the binary name', () => {
    expect(CURSOR_COMMAND).toBe(UPSTREAM_COMMAND);
  });

  it('agrees with upstream on every command-matching case', () => {
    const cases = [
      'cursor-agent', '/opt/homebrew/bin/cursor-agent', 'C:\\Tools\\cursor-agent.exe',
      'CURSOR-AGENT', 'cursor', '/usr/local/bin/cursor', 'cursor-agent.cmd', 'claude', '',
    ];
    for (const c of cases) {
      expect(isCursorCommand(c), `disagreement on ${JSON.stringify(c)}`).toBe(upstreamIsCursorCommand(c));
    }
  });

  it('exposes the shipped TUI provider id (toolkit-native, no upstream twin)', () => {
    expect(CURSOR_TUI_ID).toBe('cursor-tui');
  });
});

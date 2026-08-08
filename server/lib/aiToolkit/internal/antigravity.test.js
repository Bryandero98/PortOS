import { describe, it, expect } from 'vitest';
import { ANTIGRAVITY_CONFIGURED_DEFAULT, isAntigravityCommand, parseAntigravityModelList } from './antigravity.js';
// The toolkit SOURCE may not import out to server/lib (see ../CLAUDE.md); a test
// may, and this is the only way to actually pin the duplication it documents.
import { isAntigravityCommand as upstreamIsAntigravityCommand } from '../../antigravity.js';

// `agy models` prints one bare id per line. Shape reproduced from the real
// binary: a blank line, the ids, and (on some builds) a status/banner line the
// filter has to reject.
const REAL_OUTPUT = `
gemini-3.1-pro-high
gemini-3.1-pro
claude-sonnet-4-6
gpt-5.2-codex

`;

describe('parseAntigravityModelList', () => {
  // Success-path coverage for the parser extracted out of providers.js. Without
  // it, `agy models` had no test that ever fed the filter real output — only a
  // spawn-failure case — so narrowing the character class or dropping the
  // sentinel filter would have kept the whole suite green.
  it('extracts bare ids and drops blank lines', () => {
    expect(parseAntigravityModelList(REAL_OUTPUT)).toEqual([
      'gemini-3.1-pro-high',
      'gemini-3.1-pro',
      'claude-sonnet-4-6',
      'gpt-5.2-codex',
    ]);
  });

  it('drops banner/status prose — anything that is not a bare id', () => {
    const out = parseAntigravityModelList('Available models:\ngemini-3.1-pro\nTip: use --model <id>\n');
    expect(out).toEqual(['gemini-3.1-pro']);
  });

  it('drops the configured-default sentinel so the caller can re-prepend it once', () => {
    // The caller does `[SENTINEL, ...new Set(listed)]`. If the filter let the
    // sentinel through, it would appear twice on any build that lists it.
    const out = parseAntigravityModelList(`${ANTIGRAVITY_CONFIGURED_DEFAULT}\ngemini-3.1-pro\n`);
    expect(out).toEqual(['gemini-3.1-pro']);
    expect(out).not.toContain(ANTIGRAVITY_CONFIGURED_DEFAULT);
  });

  it('handles CRLF line endings', () => {
    expect(parseAntigravityModelList('gemini-3.1-pro\r\nclaude-sonnet-4-6\r\n'))
      .toEqual(['gemini-3.1-pro', 'claude-sonnet-4-6']);
  });

  it('accepts the punctuation real ids use, and rejects ids with spaces', () => {
    expect(parseAntigravityModelList('gpt-5.2-codex\nqwen2.5:7b\nvendor/model\nnot an id\n'))
      .toEqual(['gpt-5.2-codex', 'qwen2.5:7b', 'vendor/model']);
  });

  it('returns an empty list for blank and non-string input', () => {
    // The caller turns empty into a THROW, so this must not invent entries.
    expect(parseAntigravityModelList('')).toEqual([]);
    expect(parseAntigravityModelList('\n\n')).toEqual([]);
    expect(parseAntigravityModelList(null)).toEqual([]);
    expect(parseAntigravityModelList(undefined)).toEqual([]);
  });
});

describe('vendored copy stays in sync with server/lib/antigravity.js', () => {
  it('agrees with upstream on every command-matching case', () => {
    const cases = [
      'agy', 'antigravity', '/opt/homebrew/bin/agy', 'C:\\Tools\\agy.exe', 'AGY',
      'agy.cmd', 'claude', 'cursor-agent', '',
    ];
    for (const c of cases) {
      expect(isAntigravityCommand(c), `disagreement on ${JSON.stringify(c)}`)
        .toBe(upstreamIsAntigravityCommand(c));
    }
  });
});

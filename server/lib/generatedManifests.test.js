import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from './childProcess.js';

/**
 * Checked-in generated manifests must be addressed by CONTENT, never by
 * POSITION.
 *
 * A manifest that records "declared at foo.js:412" is rewritten by every edit
 * that inserts a line above 412 — a rename, a comment, an unrelated handler —
 * even when nothing the manifest describes has changed. The drift test that
 * keeps such a manifest honest then fires on those no-op edits, so each
 * parallel branch regenerates the same file differently and every rebase or
 * merge conflicts on it. The manifest stops being a description of the code
 * and becomes a second, position-coupled copy of it.
 *
 * The fix is the same everywhere: identify a record by something intrinsic —
 * the declaring file plus the semantic identity of the thing declared — and
 * keep any positional detail in memory, where a fresh scan can still use it
 * for verification without committing it. `apiRouteCatalog.generated.json`
 * keys declarations as `file#routerId METHOD /path`; `promptStageCallSites`
 * keys them by stage key and lists file paths only.
 *
 * This guard exists so the next generator does not have to rediscover that.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(HERE, '..', '..');

// Keys whose numeric value points into a file rather than describing content.
// `index` and `offset` are here for the same reason a line number is: they
// name a position in something that moves.
const POSITIONAL_KEYS = new Set([
  'line', 'lineNumber', 'lineNo', 'startLine', 'endLine',
  'column', 'columnNumber', 'col', 'startColumn', 'endColumn',
  'offset', 'startOffset', 'endOffset', 'charIndex', 'byteOffset',
  'loc', 'position',
]);

// A position is always a number. Several of these key names have perfectly
// good non-positional uses with a non-numeric value — a `column` naming a
// Postgres column, a `position` holding `"left"` — and rejecting those would
// make this guard block manifests it has no quarrel with.
const isPositionalValue = (value) => typeof value === 'number'
  || (typeof value === 'string' && /^\d+$/.test(value.trim()));

// A `path/to/file.js:412` (optionally `:8` for a column) pointer smuggled into
// a string, which is how a positional reference survives dropping the key.
const SOURCE_POINTER_RE = /[\w./-]+\.(?:js|jsx|mjs|cjs|ts|tsx|json|md):\d+(?::\d+)?/;

/** Every positional reference in one parsed manifest, as `jsonPath — why`. */
export const findPositionalReferences = (value, path = '$') => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findPositionalReferences(entry, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => {
      const child = `${path}.${key}`;
      if (POSITIONAL_KEYS.has(key) && isPositionalValue(entry)) {
        return [`${child} — positional key "${key}"`];
      }
      return findPositionalReferences(entry, child);
    });
  }
  if (typeof value === 'string' && SOURCE_POINTER_RE.test(value)) {
    return [`${path} — file:line pointer in "${value}"`];
  }
  return [];
};

// `git ls-files` prints POSIX separators, so join against the repo root rather
// than trusting the string to be a usable path on Windows.
const trackedManifests = () => execFileSync('git', ['ls-files', '*.generated.json'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).split('\n').filter(Boolean);

describe('checked-in generated manifests', () => {
  it('finds the manifests it is meant to guard', () => {
    // A regression here means the glob stopped matching and every assertion
    // below started passing vacuously.
    expect(trackedManifests()).toEqual(expect.arrayContaining([
      'server/lib/apiRouteCatalog.generated.json',
      'server/lib/promptStageCallSites.generated.json',
    ]));
  });

  it('records no line, column, or offset pointers into the source they describe', () => {
    const offenders = trackedManifests().flatMap((relativePath) => {
      const parsed = JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
      return findPositionalReferences(parsed).map((reason) => `${relativePath}: ${reason}`);
    });
    expect(offenders, [
      'A generated manifest is pointing at a position in a file instead of at its content.',
      'Line numbers move on edits that change nothing the manifest describes, so the',
      'drift test rewrites the file on unrelated commits and every parallel branch',
      'conflicts on it. Key the record by file + semantic identity instead, and keep',
      'the position in memory for the generator\'s own verification.',
    ].join(' ')).toEqual([]);
  });

  // Bypass probe: the detector must actually fire, or the assertion above is
  // just asserting that JSON.parse succeeded.
  it('flags positional data wherever it hides', () => {
    expect(findPositionalReferences({ routes: [{ sources: [{ source: 'a.js', line: 12 }] }] }))
      .toEqual(['$.routes[0].sources[0].line — positional key "line"']);
    expect(findPositionalReferences({ sources: ['server/routes/a.js:412'] }))
      .toEqual(['$.sources[0] — file:line pointer in "server/routes/a.js:412"']);
    expect(findPositionalReferences({ at: { startLine: 3, endLine: 9 } }))
      .toHaveLength(2);
    // A numeric string is still a position — dropping the type doesn't help.
    expect(findPositionalReferences({ loc: { line: '412' } }))
      .toEqual(['$.loc.line — positional key "line"']);
    // Plain file paths and ordinary counts are what a manifest SHOULD contain,
    // and a positional-sounding key holding a non-numeric value is not a
    // position at all — a Postgres column name, a layout side.
    expect(findPositionalReferences({ sources: ['server/routes/a.js'], stats: { operations: 2153 } }))
      .toEqual([]);
    expect(findPositionalReferences({ column: 'user_id', position: 'left' }))
      .toEqual([]);
  });
});

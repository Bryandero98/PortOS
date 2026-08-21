import { describe, it, expect } from 'vitest';
import { compareBuildStamps, describeBuild } from './buildStamp.js';

describe('compareBuildStamps', () => {
  it('matches a bundle short commit against the server short commit', () => {
    const result = compareBuildStamps({ commit: 'abc1234' }, { shortCommit: 'abc1234', commit: 'abc1234def' });
    expect(result.state).toBe('match');
    expect(result.bundleCommit).toBe('abc1234');
    expect(result.serverCommit).toBe('abc1234');
  });

  it('matches a short bundle commit against a full server commit on the common prefix', () => {
    // The server may send only the full sha; comparing full-vs-short verbatim
    // would report a permanent false mismatch.
    const result = compareBuildStamps(
      { commit: 'abc1234' },
      { shortCommit: null, commit: 'abc1234567890abcdef1234567890abcdef1234' }
    );
    expect(result.state).toBe('match');
  });

  it('flags a genuine mismatch — the stale-bundle case this exists for', () => {
    expect(compareBuildStamps({ commit: 'abc1234' }, { shortCommit: 'def5678' }).state).toBe('mismatch');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(compareBuildStamps({ commit: ' ABC1234 ' }, { shortCommit: 'abc1234' }).state).toBe('match');
  });

  it('reports unknown — never match — when either side is missing', () => {
    // Claiming 'match' here would assert a verification that never happened.
    for (const [bundle, server] of [
      [null, { shortCommit: 'abc1234' }],
      [{ commit: 'abc1234' }, null],
      [undefined, undefined],
      [{ commit: 'abc1234' }, { shortCommit: null, commit: null }],
    ]) {
      expect(compareBuildStamps(bundle, server).state).toBe('unknown');
    }
  });

  it('treats the empty string and the literal "unknown" placeholder as absent, not as a commit', () => {
    // A source-tarball build stamps 'unknown'; an empty string would otherwise
    // compare unequal to every real commit and cry wolf on every page load.
    expect(compareBuildStamps({ commit: '' }, { shortCommit: 'abc1234' }).state).toBe('unknown');
    expect(compareBuildStamps({ commit: 'unknown' }, { shortCommit: 'abc1234' }).state).toBe('unknown');
    expect(compareBuildStamps({ commit: 'abc1234' }, { shortCommit: 'unknown' }).state).toBe('unknown');
    expect(compareBuildStamps({ commit: 'unknown' }, { shortCommit: 'abc1234' }).bundleCommit).toBeNull();
  });

  it('ignores a non-string commit rather than coercing it', () => {
    expect(compareBuildStamps({ commit: 12345 }, { shortCommit: 'abc1234' }).state).toBe('unknown');
  });
});

describe('describeBuild', () => {
  it('renders commit, branch, and an uncommitted-changes badge', () => {
    expect(describeBuild({ commit: 'abc1234def', branch: 'main', dirty: true }))
      .toBe('abc1234 · main · uncommitted changes');
    expect(describeBuild({ commit: 'abc1234', branch: 'main', dirty: false }))
      .toBe('abc1234 · main');
  });

  it('omits a dirty badge when the check did not run', () => {
    // `null` is "we could not tell" — not "clean", and not "dirty".
    expect(describeBuild({ commit: 'abc1234', branch: 'main', dirty: null }))
      .toBe('abc1234 · main');
  });

  it('drops unknown/blank parts instead of printing placeholder text', () => {
    expect(describeBuild({ commit: 'abc1234', branch: 'unknown' })).toBe('abc1234');
    expect(describeBuild({ commit: 'abc1234', branch: '   ' })).toBe('abc1234');
  });

  it('returns null when there is nothing worth rendering', () => {
    expect(describeBuild({})).toBeNull();
    expect(describeBuild()).toBeNull();
    expect(describeBuild({ commit: 'unknown', branch: 'unknown', dirty: null })).toBeNull();
  });
});

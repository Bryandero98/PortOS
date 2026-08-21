import { describe, expect, it } from 'vitest';

import {
  CI_GATE_CHECK_NAME,
  findPassingGate,
  parseCommitParents,
  selectVerifiedCommit,
} from './verify-ci-status.js';

const passingGate = { name: CI_GATE_CHECK_NAME, status: 'completed', conclusion: 'success' };

const mergeCommit = [
  'tree 1111111111111111111111111111111111111111',
  'parent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'parent bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'author github-actions <bot@example.com> 0 +0000',
  'committer github-actions <bot@example.com> 0 +0000',
  '',
  'Merge pull request #1 from example/main',
].join('\n');

describe('parseCommitParents', () => {
  it('reads both parents of a merge commit', () => {
    expect(parseCommitParents(mergeCommit)).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
  });

  it('stops at the header so a commit message cannot forge a parent', () => {
    const forged = [
      'tree 1111111111111111111111111111111111111111',
      'parent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '',
      'parent cccccccccccccccccccccccccccccccccccccccc',
    ].join('\n');

    expect(parseCommitParents(forged)).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  });

  it('returns nothing for a root commit or empty input', () => {
    expect(parseCommitParents('tree 1111\nauthor a <a@example.com> 0 +0000\n\nroot')).toEqual([]);
    expect(parseCommitParents('')).toEqual([]);
    expect(parseCommitParents(null)).toEqual([]);
  });
});

describe('findPassingGate', () => {
  it('only accepts a completed successful gate under the exact name', () => {
    expect(findPassingGate([passingGate])).toEqual(passingGate);
    expect(findPassingGate([{ ...passingGate, conclusion: 'failure' }])).toBeNull();
    expect(findPassingGate([{ ...passingGate, status: 'in_progress', conclusion: null }])).toBeNull();
    expect(findPassingGate([{ ...passingGate, name: 'lint' }])).toBeNull();
    expect(findPassingGate([])).toBeNull();
    expect(findPassingGate(undefined)).toBeNull();
  });
});

describe('selectVerifiedCommit', () => {
  const headTree = 'tree-head';

  it('accepts the merged branch head when its tree matches', () => {
    const verified = selectVerifiedCommit([
      { sha: 'merge', tree: headTree, checkRuns: [] },
      { sha: 'prev-release', tree: 'tree-old', checkRuns: [passingGate] },
      { sha: 'main-tip', tree: headTree, checkRuns: [passingGate] },
    ], headTree);

    expect(verified).toMatchObject({ sha: 'main-tip' });
  });

  it('refuses a green parent whose tree differs from what is being released', () => {
    expect(selectVerifiedCommit([
      { sha: 'merge', tree: headTree, checkRuns: [] },
      { sha: 'prev-release', tree: 'tree-old', checkRuns: [passingGate] },
    ], headTree)).toBeNull();
  });

  it('refuses a same-tree commit whose gate did not pass', () => {
    expect(selectVerifiedCommit([
      { sha: 'main-tip', tree: headTree, checkRuns: [{ ...passingGate, conclusion: 'failure' }] },
    ], headTree)).toBeNull();
  });

  it('prefers a gate on the released commit itself', () => {
    const verified = selectVerifiedCommit([
      { sha: 'merge', tree: headTree, checkRuns: [passingGate] },
      { sha: 'main-tip', tree: headTree, checkRuns: [passingGate] },
    ], headTree);

    expect(verified).toMatchObject({ sha: 'merge' });
  });

  it('fails closed when the head tree could not be resolved', () => {
    expect(selectVerifiedCommit([
      { sha: 'main-tip', tree: null, checkRuns: [passingGate] },
    ], null)).toBeNull();
  });
});

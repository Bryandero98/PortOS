import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it, vi } from 'vitest';

import {
  FULL_CI_GATE_CHECK_NAME,
  findVerifiedSha,
  hasPassingGate,
  parseCommitSummary,
} from './verify-ci-status.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const passingGate = { name: FULL_CI_GATE_CHECK_NAME, status: 'completed', conclusion: 'success' };

describe('the full-CI gate name', () => {
  it('matches the job ci.yml actually publishes', () => {
    // A rename on either side has no symptom other than every release silently
    // paying for the full suite again, so pin the two together.
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain(`name: ${FULL_CI_GATE_CHECK_NAME}`);
  });

  it('is not the aggregate gate, which is green on scoped runs too', () => {
    expect(FULL_CI_GATE_CHECK_NAME).not.toBe('CI Gate');
  });
});

describe('parseCommitSummary', () => {
  it('reads the tree and both parents of a merge commit', () => {
    expect(parseCommitSummary('tree-sha\nparent-a parent-b')).toEqual({
      tree: 'tree-sha',
      parents: ['parent-a', 'parent-b'],
    });
  });

  it('reads a root commit as having no parents', () => {
    expect(parseCommitSummary('tree-sha\n')).toEqual({ tree: 'tree-sha', parents: [] });
  });

  it('reports no tree when git could not be asked', () => {
    expect(parseCommitSummary(null)).toEqual({ tree: null, parents: [] });
    expect(parseCommitSummary('')).toEqual({ tree: null, parents: [] });
  });
});

describe('hasPassingGate', () => {
  it('only accepts a completed successful run under the full-gate name', () => {
    expect(hasPassingGate([passingGate])).toBe(true);
    expect(hasPassingGate([{ ...passingGate, conclusion: 'failure' }])).toBe(false);
    expect(hasPassingGate([{ ...passingGate, conclusion: 'skipped' }])).toBe(false);
    expect(hasPassingGate([{ ...passingGate, status: 'in_progress', conclusion: null }])).toBe(false);
  });

  it('rejects the aggregate gate, which a scoped PR run also turns green', () => {
    expect(hasPassingGate([{ ...passingGate, name: 'CI Gate' }])).toBe(false);
  });

  it('treats an unreachable checks API the same as no gate', () => {
    expect(hasPassingGate(null)).toBe(false);
    expect(hasPassingGate([])).toBe(false);
  });
});

describe('findVerifiedSha', () => {
  const headTree = 'tree-head';
  const gated = (...shas) => vi.fn((sha) => (shas.includes(sha) ? [passingGate] : []));

  it('accepts the merged branch head when its tree matches', () => {
    const candidates = [
      { sha: 'merge', tree: headTree },
      { sha: 'prev-release', tree: 'tree-old' },
      { sha: 'main-tip', tree: headTree },
    ];

    expect(findVerifiedSha(candidates, headTree, gated('main-tip'))).toBe('main-tip');
  });

  it('never asks about a parent whose tree differs from what is being released', () => {
    const fetch = gated('prev-release');
    const candidates = [
      { sha: 'merge', tree: headTree },
      { sha: 'prev-release', tree: 'tree-old' },
    ];

    expect(findVerifiedSha(candidates, headTree, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith('prev-release');
  });

  it('stops fetching once a candidate verifies', () => {
    const fetch = gated('merge', 'main-tip');
    const candidates = [{ sha: 'merge', tree: headTree }, { sha: 'main-tip', tree: headTree }];

    expect(findVerifiedSha(candidates, headTree, fetch)).toBe('merge');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the head tree could not be resolved', () => {
    const fetch = gated('main-tip');

    expect(findVerifiedSha([{ sha: 'main-tip', tree: null }], null, fetch)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { resolveBaseSha } from './ci-base-sha.js';

const WORKFLOW = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

/** A merge-ref checkout: both parents resolve. */
const mergeRefRevParse = (rev) => ({ 'HEAD^1': BASE, 'HEAD^2': HEAD }[rev] ?? null);

/** Split the workflow into `jobs:` entries keyed by job id. */
function workflowJobs(yaml) {
  const body = yaml.slice(yaml.indexOf('\njobs:\n'));
  const jobs = {};
  let current = null;
  for (const line of body.split('\n')) {
    const header = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (header) {
      current = header[1];
      jobs[current] = [];
      continue;
    }
    if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([id, lines]) => [id, lines.join('\n')]));
}

describe('resolveBaseSha', () => {
  it('reads the base branch off the pull-request merge ref', () => {
    expect(resolveBaseSha({ eventName: 'pull_request', revParse: mergeRefRevParse })).toBe(BASE);
  });

  it('emits no base for a run that is not a pull request', () => {
    // Nightly, dispatch, and the release workflow_call all force the complete
    // suite, so there is nothing to diff against.
    expect(resolveBaseSha({ eventName: 'schedule', revParse: mergeRefRevParse })).toBeNull();
    expect(resolveBaseSha({ eventName: 'workflow_dispatch', revParse: mergeRefRevParse })).toBeNull();
    expect(resolveBaseSha({ eventName: undefined, revParse: mergeRefRevParse })).toBeNull();
  });

  it('refuses to treat a plain head-commit checkout as a merge ref', () => {
    // Without a second parent, HEAD^1 is the PR's own previous commit — using
    // it as the diff base would scope CI to the last commit of the branch.
    const headOnly = (rev) => (rev === 'HEAD^1' ? BASE : null);

    expect(resolveBaseSha({ eventName: 'pull_request', revParse: headOnly })).toBeNull();
  });

  it('emits nothing when git cannot resolve the parent at all', () => {
    expect(resolveBaseSha({ eventName: 'pull_request', revParse: () => null })).toBeNull();
  });
});

describe('ci.yml checkout depth', () => {
  const jobs = workflowJobs(WORKFLOW);

  it('never asks for full history', () => {
    // fetch-depth: 0 clones every commit in the repo on a job that only ever
    // diffs the merge ref against its own first parent.
    expect(WORKFLOW).not.toMatch(/fetch-depth:\s*0\b/);
    // Negative control: the assertion above can fail.
    expect('        with:\n          fetch-depth: 0\n').toMatch(/fetch-depth:\s*0\b/);
  });

  it('resolves the diff base in every job that consumes it', () => {
    const consumers = Object.entries(jobs)
      .filter(([, body]) => /run-ci-tests\.js|ci-test-plan\.js/.test(body));

    expect(consumers.map(([id]) => id).sort())
      .toEqual(['client', 'impact', 'server', 'windows-server']);

    for (const [id, body] of consumers) {
      expect(body, id).toMatch(/node scripts\/ci-base-sha\.js/);
      // Depth 2 is the merge commit plus both parents — the minimum that keeps
      // `<base>...HEAD` resolvable.
      expect(body, id).toMatch(/fetch-depth:\s*2\b/);
      // The event payload's base.sha can disagree with the merge ref's parent,
      // and needs history the shallow clone no longer has.
      expect(body, id).not.toMatch(/CI_BASE_SHA:\s*\$\{\{/);
    }
  });
});

describe('ci.yml required checks', () => {
  const jobs = workflowJobs(WORKFLOW);

  it('publishes the gate the branch ruleset actually requires', () => {
    expect(jobs.gate).toMatch(/name: CI Gate/);
    expect(jobs['full-gate']).toMatch(/name: Full CI Gate/);
  });

  it('no longer carries the retired legacy check-name jobs', () => {
    // `lint` was a whole runner that echoed the client job's result, and the
    // server job wore `test (24.x)`; the ruleset requires neither.
    expect(jobs.lint).toBeUndefined();
    expect(WORKFLOW).not.toMatch(/name: test \(24\.x\)/);
    expect(jobs.gate).not.toMatch(/needs\.lint\b/);
  });
});

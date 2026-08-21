#!/usr/bin/env node

// Decides whether the commit being released was ALREADY validated by a full CI
// run, so the release workflow does not repeat the ~8-minute suite the
// main -> release pull request just finished.
//
// The rule is content-based, not SHA-based: a candidate commit verifies this
// push only when its git tree is byte-identical to the tree being released AND
// it carries a completed, successful "CI Gate" check run. A merge commit on
// `release` has the same tree as the `main` tip it merged (release is strictly
// behind main), and that tip is exactly the SHA the release PR ran full CI on.
//
// Anything else — a direct push to `release`, a merge that changed the tree, a
// missing or failed gate, an unreachable API — reports `verified=false`, and
// the release workflow falls back to running the complete suite.

import { spawnSync } from 'child_process';
import { appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

export const CI_GATE_CHECK_NAME = 'CI Gate';

/** Parent SHAs from a raw `git cat-file -p <commit>` payload. */
export function parseCommitParents(commitObject) {
  // The header ends at the first blank line. Stop there, or a commit message
  // body line beginning with "parent " would forge a candidate.
  const lines = String(commitObject || '').split('\n');
  const headerEnd = lines.indexOf('');
  return lines
    .slice(0, headerEnd === -1 ? lines.length : headerEnd)
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length).trim())
    .filter(Boolean);
}

/** The completed, successful CI gate in a `/check-runs` payload, or null. */
export function findPassingGate(checkRuns, gateName = CI_GATE_CHECK_NAME) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  return runs.find((run) => (
    run?.name === gateName
    && run?.status === 'completed'
    && run?.conclusion === 'success'
  )) || null;
}

/**
 * Pick the commit whose green CI gate vouches for `headTree`.
 *
 * @param {Array<{sha: string, tree: string|null, checkRuns: Array}>} candidates
 * @param {string} headTree tree SHA of the commit being released
 */
export function selectVerifiedCommit(candidates, headTree, gateName = CI_GATE_CHECK_NAME) {
  if (!headTree) return null;
  for (const candidate of candidates) {
    if (!candidate?.tree || candidate.tree !== headTree) continue;
    const gate = findPassingGate(candidate.checkRuns, gateName);
    if (gate) return { sha: candidate.sha, gate };
  }
  return null;
}

const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
};

const gitTree = (sha) => capture('git', ['rev-parse', `${sha}^{tree}`]);

function fetchCheckRuns(repo, sha) {
  const body = capture('gh', ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
  if (!body) {
    console.warn(`⚠️  Could not read check runs for ${sha.slice(0, 8)}.`);
    return [];
  }
  return JSON.parse(body).check_runs || [];
}

const writeOutput = (name, value) => {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
};

function emit(verified, sha, reason) {
  writeOutput('verified', verified);
  writeOutput('sha', sha);
  writeOutput('reason', reason);
}

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const head = process.env.GITHUB_SHA || capture('git', ['rev-parse', 'HEAD']);
  if (!repo || !head) {
    console.log('❔ No repository or head SHA available — requiring a full CI run.');
    emit(false, '', 'missing repository or head SHA');
    return;
  }

  const headTree = gitTree(head);
  const commitObject = capture('git', ['cat-file', '-p', head]) || '';
  // HEAD first: a workflow_dispatch or re-run may have gated this exact SHA.
  // Parents are content-checked too, so the previous release tip cannot vouch
  // for a merge that actually changed the tree.
  const candidates = [head, ...parseCommitParents(commitObject)].map((sha) => {
    const tree = gitTree(sha);
    return { sha, tree, checkRuns: tree === headTree ? fetchCheckRuns(repo, sha) : [] };
  });

  const verified = selectVerifiedCommit(candidates, headTree);
  if (verified) {
    const short = verified.sha.slice(0, 8);
    console.log(`✅ CI Gate already passed on ${short} with this exact tree — skipping the full suite.`);
    emit(true, verified.sha, `CI Gate succeeded on ${short} with an identical tree`);
    return;
  }

  console.log('🧪 No green CI Gate found for this tree — running the full suite.');
  emit(false, '', 'no successful CI Gate found for this tree');
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) main();

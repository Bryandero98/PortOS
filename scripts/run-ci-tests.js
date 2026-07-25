#!/usr/bin/env node

import { spawnSync } from 'child_process';

const scope = process.argv[2];
if (!['server', 'client'].includes(scope)) {
  console.error('Usage: node scripts/run-ci-tests.js <server|client>');
  process.exit(2);
}

const mode = process.env.CI_TEST_MODE || 'full';
const baseSha = process.env.CI_BASE_SHA;
const repoFiles = JSON.parse(process.env.CI_TEST_FILES || '[]');

const toRunnerPath = (path) => {
  // Prefix in-root selectors so a contributor-controlled filename beginning
  // with "-" cannot be interpreted as another Vitest CLI option.
  if (scope === 'client') return `./${path.replace(/^client\//, '')}`;
  if (path.startsWith('server/')) return `./${path.replace(/^server\//, '')}`;
  return `../${path}`;
};

const selectedFiles = repoFiles.map(toRunnerPath);
const relatedArgs = [];
if (mode === 'files') {
  // Exact file selectors are passed as an argv array below.
} else if (mode === 'related') {
  if (!baseSha) {
    console.error('CI_BASE_SHA is required for related-test mode.');
    process.exit(2);
  }
  relatedArgs.push('--changed', baseSha);
} else if (mode !== 'full') {
  console.error(`Unsupported CI test mode: ${mode}`);
  process.exit(2);
}

if (mode === 'files' && selectedFiles.length === 0) {
  console.log(`No ${scope} tests selected.`);
  process.exit(0);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (extraArgs, label) => {
  const args = ['run', 'test:ci', '--prefix', scope];
  if (extraArgs.length > 0) args.push('--', ...extraArgs);
  console.log(`Running ${scope} ${label}${extraArgs.length ? ` (${extraArgs.length} selector argument(s))` : ''}.`);
  const result = spawnSync(npmCommand, args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
};

if (mode === 'full') {
  process.exit(run([], 'full suite'));
}
if (mode === 'files') {
  // Feature-name matching catches cross-surface tests that do not import the
  // changed module directly. Vitest's graph catches differently named direct
  // dependants. Run both sets so targeted CI takes their conservative union.
  if (baseSha) {
    const relatedStatus = run(['--changed', baseSha], 'related tests');
    if (relatedStatus !== 0) process.exit(relatedStatus);
  }
  process.exit(run(selectedFiles, 'feature tests'));
}

const relatedStatus = run(relatedArgs, 'related tests');
if (relatedStatus !== 0) process.exit(relatedStatus);

// Source-scanning structural tests are invisible to Vitest's import graph.
// Run the planner's explicit guard list as a second small pass.
if (selectedFiles.length > 0) {
  process.exit(run(selectedFiles, 'explicit structural tests'));
}
process.exit(0);

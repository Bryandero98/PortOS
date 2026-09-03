import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeGitSandbox, destroyGitSandbox, SKIP_HEAVY_INTEGRATION } from '../server/lib/gitTestRepo.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_SH = join(REPO_ROOT, 'update.sh');

// Everything update.sh shells out to between the pm2 delete and the pm2 start.
// Stubbing them lets the success path run end to end offline, which is the only
// way to prove the exit trap does NOT start the apps a second time.
const STUB_SCRIPTS = [
  'setup-data.js', 'setup-db.js', 'setup-browser.js', 'setup-ghostty.js',
  'setup-cert.js', 'setup-guide.js', 'run-migrations.js',
  'verify-server-health.js', 'print-access-url.js', 'open-ui-in-browser.js'
];

/**
 * A throwaway checkout of update.sh with `npm`, `npx` and `pm2` shimmed, so the
 * assertions below are what the script actually does to PM2 rather than a grep
 * for the guard's source text. The rationale for the guard itself lives with it
 * in update.sh.
 *
 * @param {{origin?: boolean, failInstall?: boolean, healthy?: boolean}} options
 *   origin:false leaves the checkout with no upstream, so the git-pull step
 *   fails before anything is deleted. failInstall fails the first step AFTER
 *   the pm2 delete that does not also wipe node_modules (safe_install's retry
 *   would delete the pm2 shim with it). healthy:false makes the health probe
 *   report the restarted server never came back.
 */
async function makeSandbox({ origin = true, failInstall = true, healthy = true } = {}) {
  const { scratch, repo } = await makeGitSandbox({ origin, prefix: 'portos-update-guard-' });
  const bin = join(scratch, 'bin');
  const calls = join(scratch, 'pm2-calls.log');

  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'pm2', 'bin'), { recursive: true });

  copyFileSync(UPDATE_SH, join(repo, 'update.sh'));
  chmodSync(join(repo, 'update.sh'), 0o755);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'sandbox', version: '0.0.0' }));
  writeFileSync(join(repo, 'ecosystem.config.cjs'), 'module.exports = { apps: [] };\n');

  // Records every pm2 invocation the script makes, in order.
  writeFileSync(join(repo, 'node_modules', 'pm2', 'package.json'), JSON.stringify({ name: 'pm2', version: '0.0.0' }));
  writeFileSync(
    join(repo, 'node_modules', 'pm2', 'bin', 'pm2'),
    `require('fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\n`
  );

  writeFileSync(join(repo, 'scripts', 'trusted-rebuilds.js'), `process.exit(${failInstall ? 1 : 0});\n`);
  for (const stub of STUB_SCRIPTS) {
    writeFileSync(join(repo, 'scripts', stub), 'process.exit(0);\n');
  }
  writeFileSync(join(repo, 'scripts', 'verify-server-health.js'), `process.exit(${healthy ? 0 : 1});\n`);
  // Non-zero means "the daemon is already ours", which skips the co-located
  // `pm2 update` restart — the branch a healthy install takes.
  writeFileSync(join(repo, 'scripts', 'pm2-daemon-refresh.js'), 'process.exit(1);\n');

  // The workspaces safe_install cd's into, and the dependency it sanity-checks.
  for (const ws of ['client', 'server', 'autofixer']) {
    mkdirSync(join(repo, ws), { recursive: true });
    writeFileSync(join(repo, ws, 'package.json'), JSON.stringify({ name: ws, version: '0.0.0' }));
  }
  mkdirSync(join(repo, 'client', 'node_modules', 'vite', 'bin'), { recursive: true });
  writeFileSync(join(repo, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '');

  // update.sh only ever calls these as bare commands, so a PATH shim covers
  // every install and the slash-do refresh without touching the network.
  for (const shim of ['npm', 'npx']) {
    writeFileSync(join(bin, shim), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, shim), 0o755);
  }

  return { scratch, repo, bin, calls };
}

// The three runs share no state, so they go out concurrently rather than
// serializing three full update scripts.
function runUpdate(sandbox) {
  return new Promise((resolve) => {
    const child = spawn('bash', [join(sandbox.repo, 'update.sh')], {
      cwd: sandbox.repo,
      env: { ...process.env, PATH: `${sandbox.bin}:${process.env.PATH}` }
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', () => {});
    child.on('close', (status) => resolve({ status, stdout }));
  });
}

const pm2Calls = (sandbox) =>
  (existsSync(sandbox.calls) ? readFileSync(sandbox.calls, 'utf8') : '').split('\n').filter(Boolean);

describe.skipIf(process.platform === 'win32' || SKIP_HEAVY_INTEGRATION)('update.sh headless-install guard', () => {
  const sandboxes = {};
  const results = {};

  beforeAll(async () => {
    const cases = {
      failed: { failInstall: true },
      clean: { failInstall: false },
      preDelete: { origin: false },
      unhealthy: { failInstall: true, healthy: false }
    };
    await Promise.all(Object.entries(cases).map(async ([name, options]) => {
      sandboxes[name] = await makeSandbox(options);
    }));
    await Promise.all(Object.keys(cases).map(async (name) => {
      results[name] = await runUpdate(sandboxes[name]);
    }));
  }, 180000);

  afterAll(async () => {
    await Promise.all(Object.values(sandboxes).map(box => destroyGitSandbox(box.scratch)));
  });

  it('restarts the PM2 apps it deleted when a later step aborts the update', () => {
    const calls = pm2Calls(sandboxes.failed);
    const deleteAt = calls.findIndex(c => c.startsWith('delete ecosystem.config.cjs'));
    const startAt = calls.findIndex(c => c.startsWith('start ecosystem.config.cjs'));
    expect(deleteAt, `pm2 calls were: ${JSON.stringify(calls)}`).toBeGreaterThan(-1);
    expect(startAt, `pm2 calls were: ${JSON.stringify(calls)}`).toBeGreaterThan(deleteAt);
  });

  it('still reports the update as failed after recovering', () => {
    expect(results.failed.status).not.toBe(0);
    expect(results.failed.stdout).toContain('STEP:restart:warning:');
  });

  it('starts the apps exactly once on an update that succeeds', () => {
    expect(results.clean.status, results.clean.stdout).toBe(0);
    expect(pm2Calls(sandboxes.clean).filter(c => c.startsWith('start ecosystem.config.cjs'))).toHaveLength(1);
    expect(results.clean.stdout).toContain('STEP:restart:done:');
    expect(results.clean.stdout).not.toContain('STEP:restart:warning:');
  });

  it('does not claim a recovery the health probe never confirmed', () => {
    expect(results.unhealthy.status).not.toBe(0);
    expect(results.unhealthy.stdout).toContain('STEP:restart:error:');
    expect(results.unhealthy.stdout).not.toContain('STEP:restart:warning:');
  });

  it('does not touch PM2 when the update aborts before the delete', () => {
    expect(results.preDelete.status).not.toBe(0);
    expect(pm2Calls(sandboxes.preDelete)).toEqual([]);
  });
});

/**
 * update.ps1 is the Windows half of the same bracket and cannot be executed
 * here, so guard the invariant that makes its recovery reachable: every fatal
 * exit between the pm2 delete and the successful start must route through
 * Stop-UpdateScript. A future step added to that window with a bare `exit`
 * would silently reintroduce the headless failure on Windows only.
 */
describe('update.ps1 headless-install guard', () => {
  const ps1 = readFileSync(join(REPO_ROOT, 'update.ps1'), 'utf8').split('\n');
  const lineOf = (needle) => ps1.findIndex(line => line.includes(needle));

  it('routes every fatal exit in the delete→start window through the recovery', () => {
    const deleteAt = lineOf('$script:Pm2AppsDown = $true');
    // The latch is cleared in Restore-Pm2Apps too; the LAST clear is the real start.
    const startedAt = ps1.findLastIndex(line => line.includes('$script:Pm2AppsDown = $false'));
    expect(deleteAt).toBeGreaterThan(-1);
    expect(startedAt).toBeGreaterThan(deleteAt);

    const rawExits = ps1
      .slice(deleteAt, startedAt)
      .map((line, i) => ({ line: line.trim(), number: deleteAt + i + 1 }))
      .filter(({ line }) => /(^|[{;]\s*)exit\b/.test(line));
    expect(rawExits, `bare exit(s) skip Restore-Pm2Apps: ${JSON.stringify(rawExits)}`).toEqual([]);
  });

  it('installs the recovery before the delete that makes it necessary', () => {
    expect(lineOf('function Restore-Pm2Apps')).toBeLessThan(lineOf('$script:Pm2AppsDown = $true'));
    expect(lineOf('trap {')).toBeLessThan(lineOf('$script:Pm2AppsDown = $true'));
  });
});

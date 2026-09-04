import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { pinPlatform } from '../lib/testHelper.js';

vi.mock('../lib/childProcess.js', () => ({
  spawn: vi.fn()
}));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { root: '/mock', data: '/mock/data' }
}));

vi.mock('../lib/detachedSpawn.js', () => ({
  spawnDetached: vi.fn(),
  isDetachedRunning: vi.fn().mockResolvedValue(false)
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./updateChecker.js', () => ({
  recordUpdateResult: vi.fn().mockResolvedValue(undefined),
  getCurrentVersion: vi.fn().mockResolvedValue('0.0.0')
}));

import { spawn } from '../lib/childProcess.js';
import { spawnDetached, isDetachedRunning } from '../lib/detachedSpawn.js';
import { readFile } from 'fs/promises';
import { recordUpdateResult, getCurrentVersion } from './updateChecker.js';
import { executeUpdate } from './updateExecutor.js';

// The spawnDetached handle deliberately has NO unref (its launcher already
// unref'd) — executeUpdate must use `child.unref?.()`. Only the win32
// plain-spawn test adds a real ChildProcess-style unref to its mock.
function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  return child;
}

// executeUpdate awaits spawnDetached before wiring its event listeners, so
// tests must flush the microtask/immediate queue after calling it and before
// emitting child events, or the emission fires into the void.
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function startUpdate(...args) {
  const promise = executeUpdate(...args);
  await flush();
  // Wrapped in an object so `await startUpdate(...)` does not flatten the
  // still-pending executeUpdate promise (which only settles after 'close').
  return { promise };
}

// executeUpdate branches on process.platform, and every test below except the
// first asserts the POSIX (spawnDetached) launch path. Pin the platform so
// they exercise that path on a Windows host too — otherwise they take the
// powershell branch, the cleared spawn() mock returns undefined, and each one
// hangs to the timeout. Safe here: updateExecutor.js and its (mocked) deps
// load no native addon that picks its binary from process.platform.
let restorePlatform = () => {};

afterEach(() => restorePlatform());

beforeEach(() => {
  restorePlatform = pinPlatform('linux');
  vi.clearAllMocks();
  // Default: marker file not found (tests that need it override this)
  readFile.mockRejectedValue(new Error('ENOENT'));
  // Default: no prior update script still running
  isDetachedRunning.mockResolvedValue(false);
});

describe('executeUpdate', () => {
  // Regression for issue #6169: a plain spawn(..., {detached:true}) on
  // Windows maps to DETACHED_PROCESS, which gives powershell.exe no console —
  // it exits in ~100ms without running a single line of update.ps1, so the
  // update never actually ran despite reporting success. Windows must launch
  // through spawnDetached's windowsDetached:true two-hop PowerShell launcher,
  // exactly like POSIX goes through its double-fork.
  it('launches via spawnDetached with windowsDetached:true on Windows', async () => {
    // Re-pin over the file-level linux default; the file-level afterEach still
    // restores the pristine descriptor, so a failure here can't leak win32.
    pinPlatform('win32');
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\n'));
    child.emit('close', 0);
    await promise;

    expect(spawn).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']),
      expect.objectContaining({ windowsDetached: true })
    );
  });

  // Regression for the reconcile "shuts down but never restarts" failure: a
  // plain spawn(detached:true) child is still a PPID-descendant of
  // portos-server, so update.sh's own `pm2 delete` tree-killed the script
  // before it could run the final `pm2 start`. POSIX must launch through
  // spawnDetached's double-fork (reparent to init) instead.
  it('launches via spawnDetached with a control dir on POSIX', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 0);
    await promise;

    expect(spawn).not.toHaveBeenCalled();
    expect(isDetachedRunning).toHaveBeenCalledWith(
      expect.stringContaining('update-detached'),
      {
        executable: 'bash',
        args: [expect.stringContaining('update.sh')]
      }
    );
    expect(spawnDetached).toHaveBeenCalledWith(
      'bash',
      [expect.stringContaining('update.sh')],
      expect.objectContaining({
        cwd: '/mock',
        controlDir: expect.stringContaining('update-detached')
      })
    );
  });

  it('continues when a stale control PID does not match the update process', async () => {
    isDetachedRunning.mockResolvedValue(false);
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\n'));
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  // Reusing the fixed control dir while the prior update script is still
  // alive would let the old supervisor's late `exit` write prematurely close
  // the new handle with the old script's status — so a still-running script
  // must refuse the new update instead of spawning over it.
  it('refuses to spawn while a prior update script is still running', async () => {
    isDetachedRunning.mockResolvedValue(true);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('starting');
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, log: expect.stringContaining('still running') })
    );
    expect(emits.some(e => e[0] === 'starting' && e[1] === 'error')).toBe(true);
  });

  it('parses STEP markers from stdout', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));

    // Simulate STEP output
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\n'));
    child.stdout.emit('data', Buffer.from('STEP:git-pull:done:Latest changes pulled\n'));

    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(emits.some(e => e[0] === 'git-pull' && e[1] === 'running')).toBe(true);
    expect(emits.some(e => e[0] === 'git-pull' && e[1] === 'done')).toBe(true);
  });

  // Regression for issue #6169 point 4: the triggering tag is only ever a
  // request, not proof of what actually landed — a fresh on-disk
  // package.json read is the only trustworthy fallback when the completion
  // marker was never written (e.g. the script never actually ran).
  it('falls back to a fresh package.json read, never the triggering tag, when the marker is missing', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    getCurrentVersion.mockResolvedValue('3.4.5');

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\n'));
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.version).toBe('3.4.5');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ version: '3.4.5', success: true })
    );
  });

  it('records failure on non-zero exit code', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 1);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  // Regression for issue #6169: a console-less Windows spawn used to exit 0
  // within ~100ms without ever running a line of update.ps1, and the old
  // `code === 0` check alone reported that as a successful update. Both
  // scripts emit their first STEP: line (git-pull:running) before touching
  // anything, so a clean exit that never emitted one is proof the script
  // never actually ran, regardless of exit code.
  it('treats a clean exit with no STEP: lines at all as a failure, not a silent success', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/never ran/i);
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, log: expect.stringMatching(/never ran/i) })
    );
    expect(emits.some((e) => e[0] === 'starting' && e[1] === 'error')).toBe(true);
  });

  // The synthetic 'starting' step is emitted once before the script has even
  // been spawned; without an explicit close-out it stays 'running' in the
  // client's per-step list for the whole update once real STEP: lines start
  // arriving under different step names.
  it('closes out the synthetic starting step once the first real step arrives', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\n'));
    child.emit('close', 0);
    await promise;

    const startingEmits = emits.filter((e) => e[0] === 'starting');
    expect(startingEmits.at(-1)[1]).toBe('done');
  });

  it('handles CRLF line endings from Windows PowerShell', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));

    // Simulate CRLF output (Windows PowerShell)
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\r\n'));
    child.stdout.emit('data', Buffer.from('STEP:git-pull:done:Latest changes pulled\r\n'));

    child.emit('close', 0);
    await promise;

    // Messages should not contain trailing \r
    const pullRunning = emits.find(e => e[0] === 'git-pull' && e[1] === 'running');
    expect(pullRunning[2]).toBe('Pulling latest changes');
    expect(pullRunning[2]).not.toMatch(/\r/);
  });

  it('returns actual version from completion marker and records result on success', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    readFile.mockResolvedValue(JSON.stringify({ version: '2.0.0', completedAt: '2026-01-01T00:00:00Z' }));

    const { promise } = await startUpdate('v1.0.0', () => {});
    child.stdout.emit('data', Buffer.from('STEP:git-pull:running:Pulling latest changes\n'));
    child.emit('close', 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.version).toBe('2.0.0');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2.0.0', success: true })
    );
  });

  it('handles spawn error', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);

    const emits = [];
    const { promise } = await startUpdate('v1.0.0', (...args) => emits.push(args));
    child.emit('error', new Error('spawn failed'));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('starting');
    expect(recordUpdateResult).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, log: 'spawn failed' })
    );
  });

  // Reconcile (issue #1779) passes the stale workspaces so update.sh force-
  // reinstalls exactly those, regardless of the commit diff.
  it('passes allowlisted forceCleanWorkspaces as PORTOS_FORCE_CLEAN_WORKSPACES', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['.', 'client'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBe('.,client');
  });

  it('does NOT set PORTOS_FORCE_CLEAN_WORKSPACES when none are given', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {});
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBeUndefined();
  });

  it('filters out non-allowlisted workspace names (no injection)', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['client', '../../etc', 'rm -rf /'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBe('client');
  });

  it('does NOT set the env when every workspace name is rejected', async () => {
    const child = createMockChild();
    spawnDetached.mockResolvedValue(child);
    const { promise } = await startUpdate('v1.0.0', () => {}, { forceCleanWorkspaces: ['bogus'] });
    child.emit('close', 0);
    await promise;
    const env = spawnDetached.mock.calls[0][2].env;
    expect(env.PORTOS_FORCE_CLEAN_WORKSPACES).toBeUndefined();
  });
});

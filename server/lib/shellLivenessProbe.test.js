import { describe, it, expect, vi } from 'vitest';
import {
  buildLivenessProbeCommand,
  parseLivenessProbeOutput,
  shellHasLiveChild,
} from './shellLivenessProbe.js';

describe('buildLivenessProbeCommand', () => {
  it('builds a PowerShell Get-CimInstance query on Windows', () => {
    const probe = buildLivenessProbeCommand(1234, 'win32');
    expect(probe.file).toBe('powershell');
    expect(probe.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object -ExpandProperty ParentProcessId',
    ]);
  });

  it('builds a POSIX ps command on macOS / Linux', () => {
    expect(buildLivenessProbeCommand(1234, 'darwin')).toEqual({
      file: 'ps',
      args: ['-Ao', 'ppid='],
    });
    expect(buildLivenessProbeCommand(1234, 'linux')).toEqual({
      file: 'ps',
      args: ['-Ao', 'ppid='],
    });
  });

  it('defaults to process.platform when platform argument is omitted', () => {
    const probe = buildLivenessProbeCommand(1234);
    if (process.platform === 'win32') {
      expect(probe.file).toBe('powershell');
    } else {
      expect(probe.file).toBe('ps');
    }
  });
});

describe('parseLivenessProbeOutput', () => {
  it('parses output matching the shell pid', () => {
    expect(parseLivenessProbeOutput('1\n1\n1234\n999', 1234)).toBe(true);
    expect(parseLivenessProbeOutput('1\n1\n999', 1234)).toBe(false);
  });

  it('returns false for empty or garbage output', () => {
    expect(parseLivenessProbeOutput('', 1234)).toBe(false);
    expect(parseLivenessProbeOutput(null, 1234)).toBe(false);
    expect(parseLivenessProbeOutput('   \n', 1234)).toBe(false);
    expect(parseLivenessProbeOutput('ProcessId\n---------\n', 1234)).toBe(false);
  });
});

describe('shellHasLiveChild', () => {
  it('resolves true immediately if shellPid is missing or 0', async () => {
    expect(await shellHasLiveChild(null)).toBe(true);
    expect(await shellHasLiveChild(0)).toBe(true);
    expect(await shellHasLiveChild(undefined)).toBe(true);
  });

  it('resolves true (fails open) when the probe command errors', async () => {
    const mockExec = vi.fn((_file, _args, _opts, cb) => cb(new Error('command failed')));
    const result = await shellHasLiveChild(1234, {
      platform: 'darwin',
      execFileFn: mockExec,
    });
    expect(result).toBe(true);
  });

  it('resolves true when probe detects a live child process on POSIX', async () => {
    const mockExec = vi.fn((_file, _args, _opts, cb) => cb(null, '1\n1234\n999\n'));
    const result = await shellHasLiveChild(1234, {
      platform: 'darwin',
      execFileFn: mockExec,
    });
    expect(result).toBe(true);
  });

  it('resolves false when probe detects no child process on POSIX', async () => {
    const mockExec = vi.fn((_file, _args, _opts, cb) => cb(null, '1\n999\n'));
    const result = await shellHasLiveChild(1234, {
      platform: 'darwin',
      execFileFn: mockExec,
    });
    expect(result).toBe(false);
  });

  it('resolves true when probe detects a live child process on Windows', async () => {
    const mockExec = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe('powershell');
      cb(null, '1\n1234\n999\n');
    });
    const result = await shellHasLiveChild(1234, {
      platform: 'win32',
      execFileFn: mockExec,
    });
    expect(result).toBe(true);
  });

  it('resolves false when probe detects no child process on Windows', async () => {
    const mockExec = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe('powershell');
      cb(null, '1\n999\n');
    });
    const result = await shellHasLiveChild(1234, {
      platform: 'win32',
      execFileFn: mockExec,
    });
    expect(result).toBe(false);
  });
});

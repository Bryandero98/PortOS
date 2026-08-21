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
      'Get-CimInstance Win32_Process -Filter "ParentProcessId = 1234" | Select-Object -ExpandProperty ProcessId',
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
  it('parses POSIX ps output matching the shell pid', () => {
    expect(parseLivenessProbeOutput('1\n1\n1234\n999', 1234, 'darwin')).toBe(true);
    expect(parseLivenessProbeOutput('1\n1\n999', 1234, 'darwin')).toBe(false);
  });

  it('parses Windows powershell output returning child pids', () => {
    expect(parseLivenessProbeOutput('5678\n', 1234, 'win32')).toBe(true);
    expect(parseLivenessProbeOutput('5678\n9012\n', 1234, 'win32')).toBe(true);
    expect(parseLivenessProbeOutput('', 1234, 'win32')).toBe(false);
    expect(parseLivenessProbeOutput('   \n', 1234, 'win32')).toBe(false);
    expect(parseLivenessProbeOutput('ProcessId\n---------\n', 1234, 'win32')).toBe(false);
  });

  it('returns false for empty stdout on all platforms', () => {
    expect(parseLivenessProbeOutput('', 1234, 'darwin')).toBe(false);
    expect(parseLivenessProbeOutput(null, 1234, 'darwin')).toBe(false);
    expect(parseLivenessProbeOutput('', 1234, 'win32')).toBe(false);
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

  it('resolves true when POSIX ps detects a live child process', async () => {
    const mockExec = vi.fn((_file, _args, _opts, cb) => cb(null, '1\n1234\n999\n'));
    const result = await shellHasLiveChild(1234, {
      platform: 'darwin',
      execFileFn: mockExec,
    });
    expect(result).toBe(true);
  });

  it('resolves false when POSIX ps detects no child process', async () => {
    const mockExec = vi.fn((_file, _args, _opts, cb) => cb(null, '1\n999\n'));
    const result = await shellHasLiveChild(1234, {
      platform: 'darwin',
      execFileFn: mockExec,
    });
    expect(result).toBe(false);
  });

  it('resolves true when Windows probe returns child processes', async () => {
    const mockExec = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe('powershell');
      cb(null, '4567\n');
    });
    const result = await shellHasLiveChild(1234, {
      platform: 'win32',
      execFileFn: mockExec,
    });
    expect(result).toBe(true);
  });

  it('resolves false when Windows probe returns empty stdout', async () => {
    const mockExec = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe('powershell');
      cb(null, '\n');
    });
    const result = await shellHasLiveChild(1234, {
      platform: 'win32',
      execFileFn: mockExec,
    });
    expect(result).toBe(false);
  });
});

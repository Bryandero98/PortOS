import { describe, it, expect, vi } from 'vitest';
import {
  buildLivenessProbeCommand,
  parseLivenessProbeOutput,
  shellHasLiveChild,
} from './shellLivenessProbe.js';

describe('buildLivenessProbeCommand', () => {
  it('builds a PowerShell Get-CimInstance query for cmd.exe', () => {
    const probe = buildLivenessProbeCommand(1234, 'C:\\WINDOWS\\system32\\cmd.exe');
    expect(probe.file).toBe('powershell');
    expect(probe.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "ParentProcessId = 1234" | Select-Object -ExpandProperty ProcessId',
    ]);
  });

  it('builds a PowerShell Get-CimInstance query for powershell.exe / pwsh', () => {
    const probe = buildLivenessProbeCommand(5678, 'pwsh.exe');
    expect(probe.file).toBe('powershell');
    expect(probe.args[3]).toContain('ParentProcessId = 5678');
  });

  it('builds a POSIX ps command for POSIX shells', () => {
    const probe = buildLivenessProbeCommand(1234, '/bin/zsh');
    expect(probe).toEqual({
      file: 'ps',
      args: ['-Ao', 'ppid='],
    });
  });

  it('keeps POSIX ps command for git-bash on Windows', () => {
    const probe = buildLivenessProbeCommand(1234, 'C:\\Program Files\\Git\\bin\\bash.exe', 'win32');
    expect(probe).toEqual({
      file: 'ps',
      args: ['-Ao', 'ppid='],
    });
  });

  it('falls back to platform default when no shell is recorded', () => {
    const winProbe = buildLivenessProbeCommand(1234, undefined, 'win32');
    expect(winProbe.file).toBe('powershell');

    const posixProbe = buildLivenessProbeCommand(1234, undefined, 'darwin');
    expect(posixProbe.file).toBe('ps');
  });
});

describe('parseLivenessProbeOutput', () => {
  it('parses POSIX ps output matching the shell pid', () => {
    expect(parseLivenessProbeOutput('1\n1\n1234\n999', 1234, '/bin/zsh')).toBe(true);
    expect(parseLivenessProbeOutput('1\n1\n999', 1234, '/bin/zsh')).toBe(false);
  });

  it('parses Windows powershell output returning child pids', () => {
    expect(parseLivenessProbeOutput('5678\n', 1234, 'cmd.exe')).toBe(true);
    expect(parseLivenessProbeOutput('5678\n9012\n', 1234, 'powershell.exe')).toBe(true);
    expect(parseLivenessProbeOutput('', 1234, 'cmd.exe')).toBe(false);
    expect(parseLivenessProbeOutput('   \n', 1234, 'cmd.exe')).toBe(false);
  });

  it('returns false for empty stdout on all flavors', () => {
    expect(parseLivenessProbeOutput('', 1234, '/bin/zsh')).toBe(false);
    expect(parseLivenessProbeOutput(null, 1234, '/bin/zsh')).toBe(false);
    expect(parseLivenessProbeOutput('', 1234, 'cmd.exe')).toBe(false);
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
      shell: '/bin/zsh',
      execFileFn: mockExec,
    });
    expect(result).toBe(true);
  });

  it('resolves true when POSIX ps detects a live child process', async () => {
    const mockExec = vi.fn((_file, _args, _opts, cb) => cb(null, '1\n1234\n999\n'));
    const result = await shellHasLiveChild(1234, {
      shell: '/bin/zsh',
      execFileFn: mockExec,
    });
    expect(result).toBe(true);
  });

  it('resolves false when POSIX ps detects no child process', async () => {
    const mockExec = vi.fn((_file, _args, _opts, cb) => cb(null, '1\n999\n'));
    const result = await shellHasLiveChild(1234, {
      shell: '/bin/zsh',
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
      shell: 'cmd.exe',
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
      shell: 'cmd.exe',
      execFileFn: mockExec,
    });
    expect(result).toBe(false);
  });
});

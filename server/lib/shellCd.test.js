import { describe, it, expect } from 'vitest';
import { buildCdCommand, detectShellFlavor } from './shellCd.js';

describe('detectShellFlavor', () => {
  it('reads the flavor off the shell binary, ignoring path and case', () => {
    expect(detectShellFlavor('C:\\WINDOWS\\system32\\cmd.exe')).toBe('cmd');
    expect(detectShellFlavor('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(detectShellFlavor('powershell.exe')).toBe('powershell');
    expect(detectShellFlavor('/bin/zsh')).toBe('posix');
    expect(detectShellFlavor('/usr/bin/fish')).toBe('posix');
  });

  it('keeps POSIX quoting for a POSIX shell running on Windows (git-bash)', () => {
    expect(detectShellFlavor('C:\\Program Files\\Git\\bin\\bash.exe', 'win32')).toBe('posix');
  });

  it('falls back to the platform default when no shell is recorded', () => {
    // PowerShell, not cmd — that is what interactiveShellResolver picks on
    // Windows, and cmd's syntax is a hard error under PowerShell.
    expect(detectShellFlavor(undefined, 'win32')).toBe('powershell');
    expect(detectShellFlavor('', 'darwin')).toBe('posix');
    expect(detectShellFlavor(null, 'linux')).toBe('posix');
  });
});

describe('buildCdCommand', () => {
  it('uses cd /d with double quotes on cmd.exe so the drive actually changes', () => {
    // The reported bug: a session started in C:\Users\… stayed there, because a
    // POSIX `cd '<path>'` neither quotes nor crosses drives under cmd.exe.
    expect(buildCdCommand('I:\\code\\example-app', 'cmd.exe'))
      .toBe('cd /d "I:\\code\\example-app"');
    expect(buildCdCommand('C:\\code\\my app', 'C:\\WINDOWS\\system32\\cmd.exe'))
      .toBe('cd /d "C:\\code\\my app"');
  });

  it('uses Set-Location -LiteralPath on PowerShell, doubling embedded quotes', () => {
    expect(buildCdCommand('D:\\code\\app', 'pwsh.exe'))
      .toBe("Set-Location -LiteralPath 'D:\\code\\app'");
    expect(buildCdCommand("D:\\code\\it's", 'powershell.exe'))
      .toBe("Set-Location -LiteralPath 'D:\\code\\it''s'");
  });

  it('leaves a Windows path alone for git-bash, which translates it itself', () => {
    expect(buildCdCommand('I:\\code\\example-app', 'C:\\Program Files\\Git\\bin\\bash.exe'))
      .toBe("cd 'I:\\code\\example-app'");
  });

  it('uses POSIX quoting elsewhere', () => {
    expect(buildCdCommand('/Users/example/code/app', '/bin/zsh'))
      .toBe("cd /Users/example/code/app");
    expect(buildCdCommand('/Users/example/my app', '/bin/bash'))
      .toBe("cd '/Users/example/my app'");
    expect(buildCdCommand("/tmp/it's", '/bin/bash'))
      .toBe("cd '/tmp/it'\\''s'");
  });

  it('drops control characters so a path cannot terminate the cd line', () => {
    expect(buildCdCommand('C:\\code\\app\r\nwhoami', 'cmd.exe')).toBe('cd /d "C:\\code\\appwhoami"');
    expect(buildCdCommand('/tmp/app\nwhoami', '/bin/zsh')).toBe('cd /tmp/appwhoami');
  });

  it('drops double quotes on cmd.exe, which has no escape for them', () => {
    expect(buildCdCommand('C:\\code\\"app"', 'cmd.exe')).toBe('cd /d "C:\\code\\app"');
  });
});

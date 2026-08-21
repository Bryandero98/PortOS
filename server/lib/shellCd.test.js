import { describe, it, expect } from 'vitest';
import { buildCdCommand, detectShellFlavor, formatShellCommandLine, quoteForShell } from './shellCd.js';

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

describe('quoteForShell', () => {
  it('preserves the existing POSIX output in command and argument positions', () => {
    expect(quoteForShell('claude', 'posix', 'command')).toBe('claude');
    expect(quoteForShell("/tmp/it's a file", 'posix', 'argument')).toBe("'/tmp/it'\\''s a file'");
  });

  it('uses the PowerShell call operator only for a quoted command token', () => {
    expect(quoteForShell("C:\\Program Files\\Claude\\it's.cmd", 'powershell', 'command'))
      .toBe("& 'C:\\Program Files\\Claude\\it''s.cmd'");
    expect(quoteForShell("I:\\input folder\\it's.md", 'powershell', 'argument'))
      .toBe("'I:\\input folder\\it''s.md'");
  });

  it('double-quotes cmd.exe tokens and drops embedded double quotes', () => {
    expect(quoteForShell('C:\\Program Files\\claude.cmd', 'cmd', 'command'))
      .toBe('"C:\\Program Files\\claude.cmd"');
    expect(quoteForShell('arg"with space', 'cmd', 'argument')).toBe('"argwith space"');
  });

  it('preserves a trailing backslash in cmd.exe tokens', () => {
    const slash = String.fromCharCode(92);
    const path = ['C:', 'work', ''].join(slash);
    expect(quoteForShell(path, 'cmd', 'argument'))
      .toBe(`"C:${slash}work${slash}${slash}"`);
  });
});

describe('formatShellCommandLine', () => {
  it('quotes the first token in command position and the rest as arguments', () => {
    expect(formatShellCommandLine('codex', ['--model', 'gpt-5'], '/bin/zsh'))
      .toBe('codex --model gpt-5');
    expect(formatShellCommandLine("C:\\Program Files\\claude.cmd", ['--effort', 'max'], 'powershell.exe'))
      .toBe("& 'C:\\Program Files\\claude.cmd' '--effort' 'max'");
  });

  it('quotes an argument containing spaces so the shell keeps it as one token', () => {
    expect(formatShellCommandLine('agy', ['--model', 'gemini 3 pro'], '/bin/zsh'))
      .toBe("agy --model 'gemini 3 pro'");
  });

  it('renders a bare command with no arguments', () => {
    expect(formatShellCommandLine('claude', [], '/bin/zsh')).toBe('claude');
    expect(formatShellCommandLine('claude', undefined, '/bin/zsh')).toBe('claude');
  });
});

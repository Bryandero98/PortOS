import { describe, it, expect } from 'vitest';
import { buildRunThenExitCommand } from './shellExit.js';

describe('buildRunThenExitCommand', () => {
  it('uses $LASTEXITCODE on PowerShell, because $? there is a boolean', () => {
    // `exit $?` under PowerShell coerces the boolean: a CLI that exited 0
    // leaves the shell with 1 and one that failed leaves 0 — exactly inverted,
    // which would record every successful agent run as a failure.
    expect(buildRunThenExitCommand('claude --model opus', 'pwsh.exe'))
      .toBe('$LASTEXITCODE = 1; claude --model opus; exit $LASTEXITCODE');
    expect(buildRunThenExitCommand('codex', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
      .toBe('$LASTEXITCODE = 1; codex; exit $LASTEXITCODE');
  });

  it('pre-seeds $LASTEXITCODE so a command that never runs still exits non-zero', () => {
    // A typo'd / missing CLI leaves $LASTEXITCODE unset, and `exit $null` is 0.
    expect(buildRunThenExitCommand('nope', 'pwsh.exe')).toMatch(/^\$LASTEXITCODE = 1;/);
  });

  it('chains with & on cmd.exe, where ; is an argument separator', () => {
    // `claude foo; exit $?` hands cmd's CLI three extra arguments (`;`, `exit`,
    // `$?`) instead of chaining. A bare `exit` carries ERRORLEVEL out.
    expect(buildRunThenExitCommand('claude --model opus', 'C:\\WINDOWS\\system32\\cmd.exe'))
      .toBe('claude --model opus & exit');
  });

  it('keeps the POSIX form for POSIX shells, including git-bash on Windows', () => {
    expect(buildRunThenExitCommand('claude', '/bin/zsh')).toBe('claude; exit $?');
    expect(buildRunThenExitCommand('claude', 'C:\\Program Files\\Git\\bin\\bash.exe'))
      .toBe('claude; exit $?');
  });

  it('falls back to the platform default when the session records no shell', () => {
    // Matches detectShellFlavor's own fallback — an externally-registered PTY
    // hands us no shell binary.
    expect(buildRunThenExitCommand('claude', undefined)).toBe(
      process.platform === 'win32' ? 'claude & exit' : 'claude; exit $?',
    );
  });
});

import { describe, it, expect, vi } from 'vitest';
import { resolveInteractiveShellWith } from './interactiveShellResolver.js';

// Windows env fixture. `exists` is driven per-test so the whole preference
// chain is reachable from a POSIX host.
const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
};
const PS5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const onlyExists = (...paths) => (p) => paths.includes(p);
// readdir and the PATH lookup are stubbed by default so the suite never depends
// on what the host machine happens to have installed.
const win = (opts = {}) => resolveInteractiveShellWith({
  platform: 'win32', env: WIN_ENV, readdir: () => ['7'], findOnPath: () => null, ...opts,
});

describe('resolveInteractiveShellWith on Windows', () => {
  it('prefers PowerShell 7+ over Windows PowerShell and cmd.exe', () => {
    // The whole point: cmd.exe cannot reach another drive by anything a user
    // would type — `cd I:` prints that drive's cwd and stays put.
    expect(win({ exists: onlyExists('C:\\Program Files\\PowerShell\\7\\pwsh.exe', PS5) }))
      .toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('picks the newest installed pwsh major, comparing numerically not as strings', () => {
    // '10' must beat '7'; a lexical sort would pick '7'.
    expect(win({
      readdir: (dir) => (dir === 'C:\\Program Files\\PowerShell' ? ['7', '10', 'preview'] : []),
      exists: (p) => p.startsWith('C:\\Program Files\\PowerShell\\'),
    })).toBe('C:\\Program Files\\PowerShell\\10\\pwsh.exe');
  });

  it('survives a machine with no PowerShell install directory to list', () => {
    // readdirSync throws on a stock box that never installed PowerShell 7+.
    expect(win({
      readdir: () => { throw new Error('ENOENT'); },
      exists: onlyExists(PS5),
    })).toBe(PS5);
  });

  it('falls back to Windows PowerShell 5.1 when pwsh is absent', () => {
    // 5.1 ships with every supported Windows and crosses drives too — it is
    // the realistic floor, not cmd.exe.
    expect(win({ exists: onlyExists(PS5) })).toBe(PS5);
  });

  it('finds a pwsh installed anywhere on PATH (scoop, choco, the Store shim)', () => {
    // Those installs have no %ProgramFiles%\PowerShell\<n> directory, so the
    // versioned scan misses them entirely.
    const scoop = 'C:\\Users\\example\\scoop\\shims\\pwsh.exe';
    expect(win({
      exists: onlyExists(PS5),
      findOnPath: (name) => (name === 'pwsh.exe' ? scoop : null),
    })).toBe(scoop);
  });

  it('does not scan PATH when a versioned pwsh install already answered', () => {
    const versioned = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const findOnPath = vi.fn(() => 'C:\\other\\pwsh.exe');
    expect(win({ exists: onlyExists(versioned), findOnPath })).toBe(versioned);
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it('uses COMSPEC only when no PowerShell exists at all', () => {
    expect(win({ exists: () => false })).toBe('C:\\Windows\\system32\\cmd.exe');
  });

  it('defaults to cmd.exe when COMSPEC is unset and no PowerShell exists', () => {
    expect(resolveInteractiveShellWith({ platform: 'win32', env: {}, exists: () => false }))
      .toBe('cmd.exe');
  });
});

describe('resolveInteractiveShellWith PORTOS_SHELL override', () => {
  it('wins over the Windows preference chain when the path exists', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(win({ env: { ...WIN_ENV, PORTOS_SHELL: bash }, exists: onlyExists(bash, PS5) })).toBe(bash);
  });

  it('is ignored when it names a path that does not exist', () => {
    // A stale `.env` entry must not strand every session on a shell that
    // cannot spawn.
    expect(win({
      env: { ...WIN_ENV, PORTOS_SHELL: 'D:\\gone\\nushell.exe' },
      exists: onlyExists(PS5),
    })).toBe(PS5);
  });

  it('passes a bare command name through unchecked, since PATH resolves it', () => {
    expect(resolveInteractiveShellWith({
      platform: 'darwin',
      env: { PORTOS_SHELL: 'fish', SHELL: '/bin/bash' },
      exists: () => false,
    })).toBe('fish');
  });

  it('ignores a blank/whitespace override', () => {
    expect(resolveInteractiveShellWith({
      platform: 'linux',
      env: { PORTOS_SHELL: '   ', SHELL: '/bin/bash' },
      exists: () => false,
    })).toBe('/bin/bash');
  });
});

describe('resolveInteractiveShellWith on POSIX', () => {
  it('uses SHELL, and zsh when it is unset — unchanged behavior', () => {
    expect(resolveInteractiveShellWith({ platform: 'darwin', env: { SHELL: '/bin/bash' } })).toBe('/bin/bash');
    expect(resolveInteractiveShellWith({ platform: 'linux', env: {} })).toBe('/bin/zsh');
  });

  it('never reaches the Windows candidates even when they exist', () => {
    expect(resolveInteractiveShellWith({ platform: 'linux', env: WIN_ENV, exists: () => true }))
      .toBe('/bin/zsh');
  });
});

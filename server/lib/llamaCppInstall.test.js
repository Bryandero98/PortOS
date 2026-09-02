import { describe, it, expect } from 'vitest';
import {
  LLAMA_CPP_WINGET_ID,
  isWingetManagedPath,
  llamaCppInstallPlan,
  parseWingetPackageFields,
  wingetLinkDirs,
} from './llamaCppInstall.js';

// Windows-shaped fixtures, deliberately usable from a macOS/Linux checkout —
// these helpers reason about Windows paths regardless of the host.
const WIN_ENV = { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };

describe('llamaCppInstallPlan', () => {
  it('installs through winget on Windows and Homebrew everywhere else', () => {
    expect(llamaCppInstallPlan('win32')).toMatchObject({
      manager: 'winget',
      installCommand: 'winget install ggml.llamacpp',
    });
    for (const platform of ['darwin', 'linux']) {
      expect(llamaCppInstallPlan(platform)).toMatchObject({
        manager: 'brew',
        installCommand: 'brew install llama.cpp',
      });
    }
  });

  it('gives winget the non-interactive flags a spawned child needs', () => {
    const { installArgs, upgradeArgs } = llamaCppInstallPlan('win32');
    for (const args of [installArgs, upgradeArgs]) {
      expect(args).toContain('--disable-interactivity');
      expect(args).toContain('--accept-source-agreements');
      expect(args).toContain('--accept-package-agreements');
      expect(args).toContain('--exact');
    }
  });
});

describe('parseWingetPackageFields', () => {
  // winget has no machine-readable output mode, so these are the shapes the real
  // command actually prints — including the localized-header case the parser
  // must not depend on.
  it('reads the version off an installed package with no update', () => {
    const stdout = [
      'Name      Id            Version Source',
      '---------------------------------------',
      'llama.cpp ggml.llamacpp b10500  winget',
    ].join('\n');
    expect(parseWingetPackageFields(stdout, LLAMA_CPP_WINGET_ID)).toEqual(['b10500', 'winget']);
  });

  it('exposes the newer build as the second field when winget lists one', () => {
    const stdout = [
      'Name      Id            Version Available Source',
      '-------------------------------------------------',
      'llama.cpp ggml.llamacpp b10500  b10730    winget',
      '1 upgrades available.',
    ].join('\r\n');
    expect(parseWingetPackageFields(stdout, LLAMA_CPP_WINGET_ID)?.[1]).toBe('b10730');
  });

  it('finds the row under a localized header', () => {
    const stdout = [
      'Nom       ID            Version Disponible Source',
      '--------------------------------------------------',
      'llama.cpp ggml.llamacpp b10500  b10730     winget',
    ].join('\n');
    expect(parseWingetPackageFields(stdout, LLAMA_CPP_WINGET_ID)?.[1]).toBe('b10730');
  });

  it('answers null for winget\'s "not installed" message', () => {
    expect(parseWingetPackageFields('No installed package found matching input criteria.', LLAMA_CPP_WINGET_ID))
      .toBeNull();
    expect(parseWingetPackageFields('', LLAMA_CPP_WINGET_ID)).toBeNull();
  });
});

describe('isWingetManagedPath', () => {
  it('claims a binary under either WinGet root', () => {
    expect(isWingetManagedPath('C:\\Users\\example\\AppData\\Local\\Microsoft\\WinGet\\Links\\llama-server.exe', WIN_ENV))
      .toBe(true);
    // Case-insensitively: Windows paths are, and PATH lookups spell them freely.
    expect(isWingetManagedPath('c:\\program files\\winget\\packages\\ggml.llamacpp\\llama-server.exe', WIN_ENV))
      .toBe(true);
  });

  it('leaves a hand-installed build alone', () => {
    // The whole point of the check: a source build or an unzipped release
    // earlier on PATH must not be offered a `winget upgrade` that would swap a
    // package the serving process is not using.
    expect(isWingetManagedPath('C:\\tools\\llama.cpp\\llama-server.exe', WIN_ENV)).toBe(false);
    expect(isWingetManagedPath('llama-server.exe', WIN_ENV)).toBe(false);
    expect(isWingetManagedPath(null, WIN_ENV)).toBe(false);
  });

  it('claims nothing when the environment names no WinGet root', () => {
    expect(isWingetManagedPath('C:\\Users\\example\\AppData\\Local\\Microsoft\\WinGet\\Links\\llama-server.exe', {}))
      .toBe(false);
    expect(wingetLinkDirs({})).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  getOpenCodeInstallStatus,
  OPENCODE_NPM_INSTALL_ARGS,
  spawnOpenCodeInstaller,
} from './opencodeInstaller.js';

describe('OpenCode installer', () => {
  it('reports runnable availability as booleans without returning local paths', async () => {
    const findCommand = vi.fn(async (command) => command === 'opencode' ? '/example/opencode' : null);
    const probeCommand = vi.fn(async () => true);

    await expect(getOpenCodeInstallStatus({ findCommand, probeCommand })).resolves.toEqual({
      installed: true,
      npmAvailable: false,
    });
    expect(findCommand).toHaveBeenCalledWith('opencode');
    expect(findCommand).toHaveBeenCalledWith('npm');
    expect(probeCommand).toHaveBeenCalledWith('/example/opencode', ['--version']);
  });

  it('reports a PATH-resolved but broken OpenCode CLI as unavailable', async () => {
    const findCommand = vi.fn(async (command) => command === 'opencode' ? '/example/opencode' : '/example/npm');
    const probeCommand = vi.fn(async () => false);

    await expect(getOpenCodeInstallStatus({ findCommand, probeCommand })).resolves.toEqual({
      installed: false,
      npmAvailable: true,
    });
    expect(probeCommand).toHaveBeenCalledWith('/example/opencode', ['--version']);
  });

  it('spawns only the fixed npm global package install without a shell', () => {
    const spawnImpl = vi.fn(() => ({ pid: 123 }));

    spawnOpenCodeInstaller({ spawnImpl });

    const [command, args, options] = spawnImpl.mock.calls[0];
    if (process.platform === 'win32') {
      // Windows must launch npm's .cmd shim through cmd.exe because Node
      // rejects direct .cmd spawns when shell:false.
      expect(command).toBe('cmd.exe');
      expect(args).toEqual([
        '/c',
        expect.stringMatching(/npm\.cmd$/i),
        ...OPENCODE_NPM_INSTALL_ARGS,
      ]);
    } else {
      expect(command).toBe('npm');
      expect(args).toEqual(OPENCODE_NPM_INSTALL_ARGS);
    }
    expect(options).toEqual(expect.objectContaining({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }));
    expect(OPENCODE_NPM_INSTALL_ARGS).toContain('--no-progress');
    expect(OPENCODE_NPM_INSTALL_ARGS).toContain('--ignore-scripts=false');
  });
});

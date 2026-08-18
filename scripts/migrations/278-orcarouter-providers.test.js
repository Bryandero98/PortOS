import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './278-orcarouter-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 278 — OrcaRouter providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-278-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds disabled presets without changing the active provider', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const out = readJson(providersPath);
    const api = out.providers.orcarouter;
    const cli = out.providers['opencode-orcarouter'];
    const tui = out.providers['opencode-orcarouter-tui'];

    expect(api).toMatchObject({
      endpoint: 'https://api.orcarouter.ai/v1',
      apiKey: '',
      models: ['orcarouter/auto'],
      enabled: false,
    });
    expect(cli).toMatchObject({ type: 'cli', orcarouterBacked: true, enabled: false });
    expect(tui).toMatchObject({ type: 'tui', orcarouterBacked: true, enabled: false, tuiIdleTimeoutMs: 180000 });
    expect(JSON.parse(cli.envVars.OPENCODE_CONFIG_CONTENT).provider.orcarouter.options.apiKey).toBeUndefined();
    expect(JSON.parse(tui.envVars.OPENCODE_CONFIG_CONTENT).provider.orcarouter.options.apiKey).toBeUndefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('preserves an existing OrcaRouter API key and custom provider', async () => {
    const existing = { id: 'orcarouter', name: 'My Orca', type: 'api', apiKey: 'sk-orca-example', enabled: true };
    writeJson(providersPath, { providers: { orcarouter: existing } });

    await migration.up({ rootDir });
    expect(readJson(providersPath).providers.orcarouter).toEqual(existing);
  });
});

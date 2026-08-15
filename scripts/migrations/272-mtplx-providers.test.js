/**
 * Test for migration 272 — add MTPLX provider presets to existing installs.
 * The shared idempotent write shell is asserted in _lib.test.js; this test pins
 * migration 272's frozen payload and its disabled-by-default contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './272-mtplx-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 272 — MTPLX providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-272-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds disabled API, OpenCode CLI, and OpenCode TUI presets without changing existing state', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    const api = out.providers.mtplx;
    const cli = out.providers['opencode-mtplx'];
    const tui = out.providers['opencode-mtplx-tui'];

    expect(api).toMatchObject({
      type: 'api',
      endpoint: 'http://127.0.0.1:8000/v1',
      models: ['mtplx'],
      defaultModel: 'mtplx',
      enabled: false,
    });
    expect(cli).toMatchObject({
      type: 'cli',
      command: 'opencode',
      args: ['run'],
      mtplxBacked: true,
      enabled: false,
    });
    expect(tui).toMatchObject({
      type: 'tui',
      command: 'opencode',
      mtplxBacked: true,
      tuiPromptDelayMs: 2500,
      tuiIdleTimeoutMs: 180000,
      enabled: false,
    });

    for (const provider of [cli, tui]) {
      const config = JSON.parse(provider.envVars.OPENCODE_CONFIG_CONTENT);
      expect(config.provider.mtplx).toMatchObject({
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://127.0.0.1:8000/v1' },
      });
    }

    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('preserves an existing MTPLX provider instead of replacing its local edits', async () => {
    const existing = { id: 'mtplx', name: 'My MTPLX', type: 'api', endpoint: 'http://127.0.0.1:9000/v1', enabled: true };
    writeJson(providersPath, { providers: { mtplx: existing } });

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers.mtplx).toEqual(existing);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './285-opencode-vllm-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 285 — OpenCode vLLM providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-285-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds both OpenCode vLLM presets, disabled, without changing the active provider', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const out = readJson(providersPath);

    expect(out.providers['opencode-vllm']).toMatchObject({
      name: 'OpenCode vLLM (Qwen3.8-27B)',
      type: 'cli',
      command: 'opencode',
      endpoint: 'http://127.0.0.1:18020/v1',
      models: ['qwen3.8-27b'],
      defaultModel: 'qwen3.8-27b',
      vllmBacked: true,
      enabled: false,
    });
    expect(out.providers['opencode-vllm-tui']).toMatchObject({
      type: 'tui',
      vllmBacked: true,
      enabled: false,
      tuiIdleTimeoutMs: 180000,
    });
    expect(out.activeProvider).toBe('claude-code');
  });

  it('declares the vllm namespace at the container endpoint in the OpenCode config', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });

    for (const id of ['opencode-vllm', 'opencode-vllm-tui']) {
      const config = JSON.parse(readJson(providersPath).providers[id].envVars.OPENCODE_CONFIG_CONTENT);
      expect(config.provider.vllm.options.baseURL).toBe('http://127.0.0.1:18020/v1');
    }
  });

  it('ships a blank apiKey so the operator pastes the compose stack key rather than a shipped secret', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    expect(out.providers['opencode-vllm'].apiKey).toBe('');
    expect(out.providers['opencode-vllm-tui'].apiKey).toBe('');
  });

  it('preserves an existing customized vLLM provider', async () => {
    const existing = {
      id: 'opencode-vllm-tui',
      name: 'Custom vLLM TUI',
      type: 'tui',
      endpoint: 'http://127.0.0.1:19000/v1',
      apiKey: 'operator-key',
      enabled: true,
    };
    writeJson(providersPath, { providers: { 'opencode-vllm-tui': existing } });

    await migration.up({ rootDir });
    const out = readJson(providersPath);
    expect(out.providers['opencode-vllm-tui']).toEqual(existing);
    // The sibling it did not already own is still added.
    expect(out.providers['opencode-vllm']).toBeDefined();
  });
});

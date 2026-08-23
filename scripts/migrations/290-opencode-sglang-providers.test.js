import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './290-opencode-sglang-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 290 — OpenCode SGLang providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-290-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds both OpenCode SGLang presets, disabled, without changing the active provider', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const out = readJson(providersPath);

    expect(out.providers['opencode-sglang']).toMatchObject({
      name: 'OpenCode SGLang (Qwen3.8-27B)',
      type: 'cli',
      command: 'opencode',
      endpoint: 'http://127.0.0.1:18021/v1',
      models: ['qwen3.8-27b'],
      defaultModel: 'qwen3.8-27b',
      sglangBacked: true,
      enabled: false,
    });
    expect(out.providers['opencode-sglang-tui']).toMatchObject({
      type: 'tui',
      sglangBacked: true,
      enabled: false,
      tuiIdleTimeoutMs: 180000,
    });
    expect(out.activeProvider).toBe('claude-code');
  });

  it('declares the sglang namespace at the container endpoint in the OpenCode config', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });

    for (const id of ['opencode-sglang', 'opencode-sglang-tui']) {
      const config = JSON.parse(readJson(providersPath).providers[id].envVars.OPENCODE_CONFIG_CONTENT);
      expect(config.provider.sglang.options.baseURL).toBe('http://127.0.0.1:18021/v1');
    }
  });

  it('never seeds a thinking default — CoS wants it off, but the operator chooses', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of ['opencode-sglang', 'opencode-sglang-tui']) {
      expect(out.providers[id].thinking).toBeUndefined();
    }
  });

  it('ships a blank apiKey — SGLang only authenticates behind --api-key', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    expect(out.providers['opencode-sglang'].apiKey).toBe('');
    expect(out.providers['opencode-sglang-tui'].apiKey).toBe('');
  });

  it('leaves the vLLM presets on their own port', async () => {
    // The two CUDA stacks are complementary, not alternatives: seeding SGLang
    // must not disturb an Ampere host's existing vLLM wrappers.
    const vllm = {
      id: 'opencode-vllm-tui', type: 'tui', endpoint: 'http://127.0.0.1:18020/v1', vllmBacked: true, enabled: true,
    };
    writeJson(providersPath, { providers: { 'opencode-vllm-tui': vllm } });

    await migration.up({ rootDir });
    const out = readJson(providersPath);
    expect(out.providers['opencode-vllm-tui']).toEqual(vllm);
    expect(out.providers['opencode-sglang-tui'].endpoint).toBe('http://127.0.0.1:18021/v1');
  });

  it('preserves an existing customized SGLang provider', async () => {
    const existing = {
      id: 'opencode-sglang-tui',
      name: 'Custom SGLang TUI',
      type: 'tui',
      endpoint: 'http://127.0.0.1:19000/v1',
      apiKey: 'operator-key',
      enabled: true,
    };
    writeJson(providersPath, { providers: { 'opencode-sglang-tui': existing } });

    await migration.up({ rootDir });
    const out = readJson(providersPath);
    expect(out.providers['opencode-sglang-tui']).toEqual(existing);
    // The sibling it did not already own is still added.
    expect(out.providers['opencode-sglang']).toBeDefined();
  });
});

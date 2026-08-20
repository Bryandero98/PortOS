import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './283-llama-server-port.js';

const OLD_ENDPOINT = 'http://127.0.0.1:8080/v1';
const NEW_ENDPOINT = 'http://127.0.0.1:5568/v1';
const oldConfig = () => JSON.stringify({
  permission: 'allow',
  provider: { llama: { options: { baseURL: OLD_ENDPOINT } } },
});
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 283 — llama-server port', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-283-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('moves the shipped endpoint and embedded OpenCode URL together', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: {
        'opencode-llama-tui': {
          id: 'opencode-llama-tui',
          endpoint: OLD_ENDPOINT,
          envVars: { OPENCODE_CONFIG_CONTENT: oldConfig() },
        },
      },
    });

    await migration.up({ rootDir });

    const provider = readJson(providersPath).providers['opencode-llama-tui'];
    expect(provider.endpoint).toBe(NEW_ENDPOINT);
    expect(JSON.parse(provider.envVars.OPENCODE_CONFIG_CONTENT).provider.llama.options.baseURL)
      .toBe(NEW_ENDPOINT);
  });

  it('preserves a provider whose OpenCode config points at a custom endpoint', async () => {
    const customEndpoint = 'http://127.0.0.1:8090/v1';
    writeJson(providersPath, {
      providers: {
        'opencode-llama-tui': {
          id: 'opencode-llama-tui',
          endpoint: OLD_ENDPOINT,
          envVars: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              provider: { llama: { options: { baseURL: customEndpoint } } },
            }),
          },
        },
      },
    });

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers['opencode-llama-tui'].endpoint).toBe(OLD_ENDPOINT);
  });
});

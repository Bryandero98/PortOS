import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './284-claude-ollama-auth-token-secret.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 284 — Claude-Ollama auth token secret', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-284-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('marks both shipped variants without changing their other settings', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-ollama',
      providers: {
        'claude-ollama': {
          id: 'claude-ollama',
          envVars: { ANTHROPIC_AUTH_TOKEN: '' },
          secretEnvVars: [],
          enabled: true,
        },
        'claude-ollama-tui': {
          id: 'claude-ollama-tui',
          envVars: { ANTHROPIC_AUTH_TOKEN: 'ollama' },
          secretEnvVars: ['CUSTOM_SECRET'],
          enabled: false,
        },
        custom: { id: 'custom', envVars: { ANTHROPIC_AUTH_TOKEN: '' }, secretEnvVars: [] },
      },
    });

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'updated', updated: 2 });
    const out = readJson(providersPath);
    expect(out.activeProvider).toBe('claude-ollama');
    expect(out.providers['claude-ollama'].secretEnvVars).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    expect(out.providers['claude-ollama'].envVars.ANTHROPIC_AUTH_TOKEN).toBe('');
    expect(out.providers['claude-ollama-tui'].secretEnvVars).toEqual(['CUSTOM_SECRET', 'ANTHROPIC_AUTH_TOKEN']);
    expect(out.providers.custom.secretEnvVars).toEqual([]);
  });

  it('is idempotent once both tokens are marked', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-ollama': { envVars: { ANTHROPIC_AUTH_TOKEN: 'ollama' }, secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'] },
        'claude-ollama-tui': { envVars: { ANTHROPIC_AUTH_TOKEN: 'ollama' }, secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'] },
      },
    });

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'already-current', updated: 0 });
  });
});

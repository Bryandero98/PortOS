import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './294-openrouter-ox-alpha.js';

const AUTO = 'openrouter/auto';
const OX_ALPHA = 'stealth/ox-alpha';
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// Exactly what migration 293 leaves behind.
const seededApi = () => ({
  models: [AUTO], defaultModel: AUTO, lightModel: AUTO, mediumModel: AUTO, heavyModel: AUTO,
});
const seededWrapper = () => ({ models: [AUTO], defaultModel: AUTO });

describe('migration 294 — OpenRouter Ox Alpha default', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-294-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds Ox Alpha to the API record and every wrapper, keeping the router as the light tier', async () => {
    writeJson(providersPath, {
      providers: {
        openrouter: seededApi(),
        'opencode-openrouter': seededWrapper(),
        'opencode-openrouter-tui': seededWrapper(),
      },
    });

    const result = await migration.up({ rootDir });
    const providers = readJson(providersPath).providers;

    expect(result).toMatchObject({ ok: true, reason: 'updated', updated: 3 });
    expect(providers.openrouter).toEqual({
      models: [AUTO, OX_ALPHA],
      defaultModel: OX_ALPHA,
      lightModel: AUTO,
      mediumModel: OX_ALPHA,
      heavyModel: OX_ALPHA,
    });
    for (const id of ['opencode-openrouter', 'opencode-openrouter-tui']) {
      expect(providers[id]).toEqual({ models: [AUTO, OX_ALPHA], defaultModel: OX_ALPHA });
    }
  });

  it('leaves a refreshed or user-pinned record alone', async () => {
    const refreshed = { models: [AUTO, 'anthropic/claude-sonnet-4', OX_ALPHA], defaultModel: AUTO };
    const pinned = { models: [AUTO], defaultModel: 'anthropic/claude-sonnet-4' };
    writeJson(providersPath, { providers: { 'opencode-openrouter-tui': refreshed, 'opencode-openrouter': pinned } });

    const result = await migration.up({ rootDir });

    expect(result).toMatchObject({ ok: true, reason: 'already-current-or-custom', updated: 0 });
    expect(readJson(providersPath).providers).toEqual({
      'opencode-openrouter-tui': refreshed,
      'opencode-openrouter': pinned,
    });
  });

  it('is a no-op on a second run', async () => {
    writeJson(providersPath, { providers: { 'opencode-openrouter-tui': seededWrapper() } });

    await migration.up({ rootDir });
    const afterFirst = readJson(providersPath);
    const second = await migration.up({ rootDir });

    expect(second).toMatchObject({ updated: 0 });
    expect(readJson(providersPath)).toEqual(afterFirst);
  });

  it('skips an install with no providers file', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: false, reason: 'no-file', updated: 0 });
  });
});

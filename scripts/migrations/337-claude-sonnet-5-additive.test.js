/**
 * Test for migration 337 — offer `claude-sonnet-5` on a Claude CLI/TUI record
 * that still lists only the retired `claude-sonnet-4-6` tier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './337-claude-sonnet-5-additive.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 337 — claude-sonnet-5 additive repair', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'portos-337-'));
    mkdirSync(join(rootDir, 'data'));
    providersPath = join(rootDir, 'data', 'providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const seed = (providers) => writeJson(providersPath, { activeProvider: 'claude-code', providers });

  it('inserts claude-sonnet-5 after the retired tier on a CURATED list 153 skipped', async () => {
    seed({
      'claude-code': {
        models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-fable-5'],
        defaultModel: 'claude-opus-5',
        mediumModel: 'claude-sonnet-4-6',
      },
    });

    const result = await migration.up({ rootDir });

    expect(result).toMatchObject({ ok: true, reason: 'updated', updated: 1 });
    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual([
      'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5',
    ]);
    // Additive: the retired id and every tier pointer survive untouched.
    expect(after.mediumModel).toBe('claude-sonnet-4-6');
    expect(after.defaultModel).toBe('claude-opus-5');
  });

  it('uses each Bedrock record\'s own region-qualified sonnet spelling', async () => {
    seed({
      'claude-code-bedrock': {
        models: ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-opus-5'],
      },
      'claude-code-tui-bedrock': {
        models: ['us.anthropic.claude-sonnet-4-6'],
      },
    });

    const result = await migration.up({ rootDir });

    expect(result.updated).toBe(2);
    const { providers } = readJson(providersPath);
    expect(providers['claude-code-bedrock'].models).toEqual([
      'us.anthropic.claude-haiku-4-5',
      'us.anthropic.claude-sonnet-4-6',
      'us.anthropic.claude-sonnet-5',
      'global.anthropic.claude-opus-5',
    ]);
    expect(providers['claude-code-tui-bedrock'].models).toEqual([
      'us.anthropic.claude-sonnet-4-6',
      'us.anthropic.claude-sonnet-5',
    ]);
    // The bare id must never leak into a Bedrock record — its environment
    // resolves only the region-qualified form.
    expect(providers['claude-code-bedrock'].models).not.toContain('claude-sonnet-5');
  });

  it('is a no-op on an already-current record and on a second run', async () => {
    seed({
      'claude-code': { models: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'] },
      'claude-code-tui': { models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5'] },
    });

    const first = await migration.up({ rootDir });
    expect(first).toMatchObject({ ok: true, reason: 'already-current', updated: 0 });

    // And a record it DID repair stays repaired rather than gaining a duplicate.
    seed({ 'claude-code': { models: ['claude-sonnet-4-6'] } });
    expect((await migration.up({ rootDir })).updated).toBe(1);
    const second = await migration.up({ rootDir });
    expect(second.updated).toBe(0);
    expect(readJson(providersPath).providers['claude-code'].models)
      .toEqual(['claude-sonnet-4-6', 'claude-sonnet-5']);
  });

  it('leaves records outside the four seeded Claude ids alone', async () => {
    seed({
      'claude-ollama': { models: ['claude-sonnet-4-6'] },
      'antigravity-cli': { models: ['claude-sonnet-4-6'] },
    });

    expect((await migration.up({ rootDir })).updated).toBe(0);
    const { providers } = readJson(providersPath);
    expect(providers['claude-ollama'].models).toEqual(['claude-sonnet-4-6']);
    expect(providers['antigravity-cli'].models).toEqual(['claude-sonnet-4-6']);
  });

  it('skips a missing or malformed providers file without throwing', async () => {
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'no-file' });

    writeFileSync(providersPath, '{not json');
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'unreadable' });

    writeJson(providersPath, { activeProvider: 'claude-code' });
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'bad-shape' });
  });

  it('skips a record whose models field is not an array', async () => {
    seed({ 'claude-code': { models: 'claude-sonnet-4-6', defaultModel: 'claude-sonnet-4-6' } });

    expect((await migration.up({ rootDir })).updated).toBe(0);
    expect(readJson(providersPath).providers['claude-code'].models).toBe('claude-sonnet-4-6');
  });
});

/**
 * Test for migration 231 — add the Cursor Agent process-provider pair (CLI + TUI)
 * to existing installs. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './231-cursor-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 231 — Cursor providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-231-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds the cli and tui Cursor providers to an existing install', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);

    const cli = out.providers['cursor-cli'];
    expect(cli.type).toBe('cli');
    expect(cli.command).toBe('cursor-agent');
    // `--force` clears the workspace-trust gate as well as auto-approving tools;
    // without it a headless run exits before doing any work.
    expect(cli.args).toEqual(['--print', '--force']);
    expect(cli.defaultModel).toBe('auto');
    expect(cli.models).toContain('auto');
    expect(cli.enabled).toBe(false);

    const tui = out.providers['cursor-tui'];
    expect(tui.type).toBe('tui');
    expect(tui.command).toBe('cursor-agent');
    expect(tui.args).toEqual(['--force']);
    expect(tui.tuiPromptDelayMs).toBe(2500);
    expect(tui.tuiIdleTimeoutMs).toBe(180000);

    // unrelated providers + active provider untouched
    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('does not overwrite a user-customized cursor entry', async () => {
    writeJson(providersPath, {
      providers: {
        'cursor-cli': { id: 'cursor-cli', type: 'cli', command: 'cursor-agent', enabled: true, defaultModel: 'composer-2.5' },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    // existing entry preserved untouched
    expect(out.providers['cursor-cli'].enabled).toBe(true);
    expect(out.providers['cursor-cli'].defaultModel).toBe('composer-2.5');
    // the still-missing TUI sibling is added alongside it
    expect(out.providers['cursor-tui']).toBeDefined();
  });

  it('deep-copies shipped arrays/objects so mutating the install cannot corrupt the frozen defaults', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const first = readJson(providersPath);
    first.providers['cursor-cli'].models.push('mutated');

    // A second install run must still ship the pristine model list.
    const rootDir2 = mkdtempSync(join(tmpdir(), 'migration-231-b-'));
    mkdirSync(join(rootDir2, 'data'), { recursive: true });
    const providersPath2 = join(rootDir2, 'data/providers.json');
    writeJson(providersPath2, { providers: {} });
    await migration.up({ rootDir: rootDir2 });
    expect(readJson(providersPath2).providers['cursor-cli'].models).not.toContain('mutated');
    rmSync(rootDir2, { recursive: true, force: true });
  });

  it('gives the CLI and TUI entries independent model arrays (they share one source list)', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);
    out.providers['cursor-cli'].models.push('leaked');
    expect(out.providers['cursor-tui'].models).not.toContain('leaked');
  });

  it('is idempotent — a second run makes no changes', async () => {
    writeJson(providersPath, {
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const afterFirst = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(providersPath, 'utf-8')).toBe(afterFirst);
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(providersPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON', async () => {
    writeFileSync(providersPath, '{ not valid json');
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });
});

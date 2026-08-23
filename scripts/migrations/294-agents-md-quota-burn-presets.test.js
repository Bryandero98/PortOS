import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './294-agents-md-quota-burn-presets.js';
import { QUOTA_BURN_PROMPT_PRESETS } from '../../server/lib/quotaBurnPresets.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const CURRENT_FRAGMENT = `Read this repository's \`AGENTS.md\` (or \`CLAUDE.md\`, and any nested
per-directory ones covering the slice) before you start, and honor its
conventions and its explicitly declared non-issues — a finding that contradicts
a documented project decision is noise, not a bug.`;

const PRIOR_FRAGMENT = `Read this repository's \`CLAUDE.md\` (and any nested per-directory ones covering
the slice) before you start, and honor its conventions and its explicitly
declared non-issues — a finding that contradicts a documented project decision
is noise, not a bug.`;

const preset = QUOTA_BURN_PROMPT_PRESETS[0];
const currentPrompt = preset.params.prompt;
const priorPrompt = currentPrompt.split(CURRENT_FRAGMENT).join(PRIOR_FRAGMENT);

describe('migration 294 — AGENTS.md quota-burn presets', () => {
  let rootDir;
  let configPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-294-'));
    mkdirSync(join(rootDir, 'data/cos'), { recursive: true });
    configPath = join(rootDir, 'data/cos/quota-burn.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('the fixture is a real prior render, not a lookalike', () => {
    // Non-vacuous guard: if the preset wording drifts, this fails here rather
    // than making the upgrade assertion below silently test nothing.
    expect(currentPrompt).toContain(CURRENT_FRAGMENT);
    expect(priorPrompt).not.toBe(currentPrompt);
    expect(priorPrompt).toContain('CLAUDE.md');
  });

  it('rewrites an unmodified stored preset render', async () => {
    writeJson(configPath, {
      families: { claude: { jobs: [{ id: 'j1', params: { prompt: priorPrompt } }] } },
    });

    const result = await migration.up({ rootDir });
    const job = readJson(configPath).families.claude.jobs[0];

    expect(result.updated).toBe(1);
    expect(job.params.prompt).toBe(currentPrompt);
    expect(job.params.prompt).toContain('AGENTS.md');
  });

  it('leaves a user-edited prompt untouched', async () => {
    // One extra character is enough to disqualify it — the rule is exact equality.
    const edited = `${priorPrompt}\n\nAlso check the sprite pipeline.`;
    writeJson(configPath, {
      families: { claude: { jobs: [{ id: 'j1', params: { prompt: edited } }] } },
    });

    const result = await migration.up({ rootDir });
    const job = readJson(configPath).families.claude.jobs[0];

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(job.params.prompt).toBe(edited);
  });

  it('ignores jobs that never carried the audit contract', async () => {
    writeJson(configPath, {
      families: { claude: { jobs: [{ id: 'j1', params: { prompt: 'do something else' } }] } },
    });

    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, skipped: 0 });
  });

  it('is a no-op when no quota-burn config exists', async () => {
    expect((await migration.up({ rootDir })).updated).toBe(0);
  });
});

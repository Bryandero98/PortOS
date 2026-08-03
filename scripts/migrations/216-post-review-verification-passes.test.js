import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './216-post-review-verification-passes.js';

describe('migration 216 — review verification passes', () => {
  let rootDir;
  let schedulePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-216-'));
    mkdirSync(join(rootDir, 'data', 'meatspace'), { recursive: true });
    schedulePath = join(rootDir, 'data', 'meatspace', 'post-review-schedule.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('starts legacy review entries at zero consecutive verification passes', async () => {
    writeFileSync(schedulePath, JSON.stringify({ skills: {
      a: { skillId: 'a', reviewsPassed: 2 },
      b: { skillId: 'b', verificationPasses: 1 },
    } }));
    expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
    const skills = JSON.parse(readFileSync(schedulePath, 'utf-8')).skills;
    expect(skills.a.verificationPasses).toBe(0);
    expect(skills.b.verificationPasses).toBe(1);
    expect(await migration.up({ rootDir })).toEqual({ updated: 0, reason: 'already-counted' });
  });

  it('no-ops when the review store is absent', async () => {
    expect(await migration.up({ rootDir })).toEqual({ updated: 0, reason: 'no-file' });
  });
});

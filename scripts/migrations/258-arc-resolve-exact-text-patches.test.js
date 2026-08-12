import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './258-arc-resolve-exact-text-patches.js';

describe('migration 258 — arc-resolve exact text patches', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-258-arc-resolve-exact-text-patches-',
  });

  it('ships the exact long-text patch contract', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-resolve.md`,
      'utf8',
    );
    expect(prompt).toContain('"patchMode": "exact-text-v1"');
    expect(prompt).toContain('`summaryEdits[]`');
    expect(prompt).toContain('`synopsisEdits[]`');
    expect(prompt).toContain('exact unique excerpt copied verbatim');
    expect(prompt).toMatch(/Never put a full stored summary/);
  });
});

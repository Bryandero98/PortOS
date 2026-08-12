import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './251-arc-resolve-field-sparsity.js';

describe('migration 251 — field-sparse bounded arc resolution', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-251-arc-resolve-',
  });

  it('documents field sparsity and every persisted string limit', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-resolve.md`,
      'utf8',
    );
    expect(prompt).toContain('return only the fields that must change');
    expect(prompt).toContain('arc logline 500 characters');
    expect(prompt).toContain('volume synopsis 8,000');
    expect(prompt).toContain('Never rely on the server to truncate prose');
  });
});

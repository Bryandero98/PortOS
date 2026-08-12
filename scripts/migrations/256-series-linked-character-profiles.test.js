import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './256-series-linked-character-profiles.js';

describe('migration 256 — series-linked character profiles', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-256-series-linked-character-profiles-',
  });

  it('requires complete supporting-cast profiles in both architect and judge', () => {
    const architect = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-character-foundation.md`,
      'utf8',
    );
    const judge = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-judge-foundation.md`,
      'utf8',
    );
    expect(architect).toContain('Fully author the bible profile');
    expect(architect).toContain('"pronouns"');
    expect(architect).toContain('"skills"');
    expect(judge).toContain('every character linked to this series');
    expect(judge).toContain('supporting character');
  });
});

import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './276-distinct-climax-arc-role-prompts.js';

describe('migration 276 — distinct climax arc role prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-276-distinct-climax-',
  });

  it('keeps climax distinct from the later finale in every role prompt', () => {
    for (const filename of Object.keys(NEW_SHIPPED_MD5)) {
      const prompt = readFileSync(`${repoRoot}/data.reference/prompts/stages/${filename}`, 'utf8');
      expect(prompt).toContain('climax');
      expect(prompt).toContain('finale');
    }
  });
});

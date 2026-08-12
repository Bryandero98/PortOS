import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './257-complete-character-expand-fields.js';

describe('migration 257 — complete character expansion fields', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-257-complete-character-expand-fields-',
  });

  it('adds every formerly unwritable visible card section', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/universe-character-expand.md`,
      'utf8',
    );
    expect(prompt).toContain('`physicalDescription`');
    expect(prompt).toContain('`personality`');
    expect(prompt).toContain('`background`');
    expect(prompt).toContain('`wardrobes`');
    expect(prompt).toContain('"wardrobes"');
  });
});

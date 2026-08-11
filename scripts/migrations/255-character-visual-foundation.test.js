import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './255-character-visual-foundation.js';

describe('migration 255 — character visual foundation', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-255-character-visual-foundation-',
  });

  it('requires render identity before the character foundation can pass', () => {
    const architect = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-character-foundation.md`,
      'utf8',
    );
    const judge = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-judge-foundation.md`,
      'utf8',
    );
    expect(architect).toContain('physicalDescription` must be 50–100 words');
    expect(architect).toContain('"colorPalette"');
    expect(judge).toContain('blank render identity');
    expect(judge).toContain('cannot score above 5');
  });
});

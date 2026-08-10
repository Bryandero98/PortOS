import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';

import { runPromptMigrationTests, repoRoot } from './_testHelpers.js';
import migration, {
  applyMigration,
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
} from './240-character-foundation-exhaustive-cast.js';

const FILENAME = 'pipeline-character-foundation.md';

describe('migration 240 — exhaustive series-cast character foundation', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-240-character-foundation-',
  });

  it('ships the target-batch and full-roster contract', () => {
    const body = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/${FILENAME}`,
      'utf8',
    );
    expect(body).toContain('`targetCharacters` is the exhaustive batch');
    expect(body).toContain('`fullSeriesRoster` is the complete story-referenced ensemble');
    expect(body).toContain('Return every supplied target');
  });
});

import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './243-post-arc-character-transition-ownership.js';

const FILENAME = 'pipeline-character-foundation.md';

describe('migration 243 — post-arc character transition ownership', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-243-character-transition-ownership-',
  });

  it('keeps episode-numbered transition beats owned by structure after the arc exists', () => {
    const body = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/${FILENAME}`,
      'utf8',
    );
    expect(body).toContain('The synopsis-level plan owns event placement');
    expect(body).toContain('preserve every existing transition beat exactly');
    expect(body).toContain('the supplied transition list is read-only evidence');
  });
});

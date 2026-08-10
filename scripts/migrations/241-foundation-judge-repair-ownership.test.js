import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './241-foundation-judge-repair-ownership.js';

const FILENAME = 'pipeline-judge-foundation.md';

describe('migration 241 — foundation judge repair ownership', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-241-foundation-judge-ownership-',
  });

  it('routes rule violations in the episode plan to the structure editor', () => {
    const body = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/${FILENAME}`,
      'utf8',
    );
    expect(body).toContain('Repair ownership boundaries');
    expect(body).toContain('an episode or finale violates it, that is a **structure** gap');
    expect(body).toContain("Each `fix` must be achievable entirely through that dimension's owning editor");
  });
});

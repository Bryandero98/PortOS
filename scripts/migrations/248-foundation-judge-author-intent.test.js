import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './248-foundation-judge-author-intent.js';

const FILENAME = 'pipeline-judge-foundation.md';

describe('migration 248 — foundation judge protected author intent', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-248-foundation-author-intent-',
  });

  it('makes divergence from the protected starter idea a broken foundation', () => {
    const body = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/${FILENAME}`,
      'utf8',
    );
    expect(body).toContain('protected author intent (starter idea)');
    expect(body).toContain('replaces, denies, or routes around that intent');
    expect(body).toContain('score the owning dimension 1–3');
  });
});

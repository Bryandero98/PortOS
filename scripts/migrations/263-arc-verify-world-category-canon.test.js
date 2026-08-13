import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './263-arc-verify-world-category-canon.js';

describe('migration 263 — arc-verify world category canon', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-263-arc-verify-world-category-canon-',
  });

  it('renders the category + composite canon the groundedness checks judge against', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-verify.md`,
      'utf8',
    );
    expect(prompt).toContain('{{worldCategoriesText}}');
    expect(prompt).toContain('{{worldCompositesText}}');
    // The blocks alone are not enough — without this rule the verifier keeps
    // reading "World canon" as the exhaustive list and flags category entities.
    expect(prompt).toContain('established world canon');
    expect(prompt).toContain('check this block before');
  });
});

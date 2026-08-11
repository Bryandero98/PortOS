import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './252-arc-resolve-avoid-list.js';

describe('migration 252 — arc-resolve corrective-pass avoid list', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-252-arc-resolve-avoid-',
  });

  it('renders the avoid list only when the corrective pass supplies one', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-resolve.md`,
      'utf8',
    );
    // Section-gated on `hasAvoid`, so a first attempt renders no avoid block at
    // all rather than an empty "do not author these: []" the model must ignore.
    expect(prompt).toContain('{{#hasAvoid}}');
    expect(prompt).toContain('{{avoidJson}}');
    expect(prompt).toContain('{{/hasAvoid}}');
    // The section has to say these problems are ABSENT from the plan — a list of
    // findings under a resolve prompt otherwise reads as more work to close.
    expect(prompt).toContain('do not author these');
    expect(prompt).toMatch(/\*\*not\*\* in the plan right now/);
  });
});

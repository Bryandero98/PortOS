import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './260-arc-resolve-isolated-repairs.js';

describe('migration 260 — arc-resolve isolated one-patch repairs', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-260-arc-resolve-isolated-repairs-',
  });

  it('ships the isolated single-patch contract behind the isolatedRepair flag', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-resolve.md`,
      'utf8',
    );
    expect(prompt).toContain('{{#isolatedRepair}}');
    expect(prompt).toContain('{{/isolatedRepair}}');
    expect(prompt).toContain('Edit **exactly one record**');
    expect(prompt).toMatch(/make \*\*exactly one change\*\*/);
    expect(prompt).toMatch(/discarded whole/);
  });
});

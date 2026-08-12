import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './259-arc-resolve-text-budgets.js';

describe('migration 259 — arc-resolve measured text budgets', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-259-arc-resolve-text-budgets-',
  });

  it('ships the measured exact-text budget contract', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-resolve.md`,
      'utf8',
    );
    expect(prompt).toContain('{{textBudgetsJson}}');
    expect(prompt).toContain('`replace.length - find.length`');
    expect(prompt).toMatch(/combined replacement delta/);
    expect(prompt).toMatch(/rejects the\s+entire replacement instead of truncating/);
  });
});

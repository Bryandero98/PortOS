import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './261-exhaustive-arc-verification.js';

describe('migration 261 — exhaustive arc verification', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-261-exhaustive-arc-verification-',
  });

  it('requires a complete cross-record defect inventory', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-verify.md`,
      'utf8',
    );
    expect(prompt).toContain('exhaustive inventory, not a sample');
    expect(prompt).toContain('Finding one defect must not stop the audit');
    expect(prompt).toContain('Cross-record fact reconciliation');
    expect(prompt).toContain('passenger/cargo manifests');
    expect(prompt).toContain('milestone is neither spent early nor repeated');
  });
});

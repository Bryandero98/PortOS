import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './250-arc-spine-checkpoint-prompts.js';

describe('migration 250 — pre-episode arc spine checkpoint prompts', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-250-arc-spine-',
  });

  it('renders volume guidance, protected intent, and spine-only rules', () => {
    const overview = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-overview.md`,
      'utf8',
    );
    const verify = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-verify.md`,
      'utf8',
    );
    expect(overview).toContain('{{recommendedStructure}}');
    expect(overview).toContain('single 12-issue volume');
    expect(verify).toContain('{{#arcSpineOnly}}');
    expect(verify).toContain('{{worldStarter}}');
    expect(verify).toContain('Protected-intent drift');
  });
});

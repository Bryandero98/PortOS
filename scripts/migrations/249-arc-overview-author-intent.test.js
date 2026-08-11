import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './249-arc-overview-author-intent.js';

const FILENAME = 'pipeline-arc-overview.md';

describe('migration 249 — arc overview protected author intent', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-249-arc-author-intent-',
  });

  it('renders the protected starter idea and derived world fields', () => {
    const body = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/${FILENAME}`,
      'utf8',
    );
    expect(body).toContain('Protected author intent (starter idea):** {{worldStarter}}');
    expect(body).toContain('{{worldPremise}}');
    expect(body).toContain('may not replace its ontology, protagonists, or core');
  });
});

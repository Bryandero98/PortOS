import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './254-arc-resolve-character-arcs.js';

describe('migration 254 — arc-resolve sparse character-arc repairs', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-254-arc-resolve-character-arcs-',
  });

  it('ships the ID-preserving sparse character-arc patch contract', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-resolve.md`,
      'utf8',
    );
    expect(prompt).toContain('{{characterArcsJson}}');
    expect(prompt).toContain('`characterArcs[]` patch');
    expect(prompt).toMatch(/repeat its existing `characterId`/);
    expect(prompt).toMatch(/transition patch must repeat its existing `id`/);
    expect(prompt).toMatch(/Unmatched\/new IDs are discarded rather than minted/);
  });
});

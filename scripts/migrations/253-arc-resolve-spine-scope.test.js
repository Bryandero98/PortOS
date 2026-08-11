import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './253-arc-resolve-spine-scope.js';

describe('migration 253 — arc-resolve spine-scoped rounds', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-253-arc-resolve-spine-',
  });

  it('scopes the pre-episode round to arc + volume edits', () => {
    const prompt = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-arc-resolve.md`,
      'utf8',
    );
    // Gated on the same flag buildVerifyContext sets for the verifier, so the
    // full arc gate (after episodes exist) renders none of this and keeps its
    // episode-correction capability.
    expect(prompt).toContain('{{#arcSpineOnly}}');
    expect(prompt).toContain('{{/arcSpineOnly}}');
    // The section has to say the episode arrays are empty BY DESIGN — a
    // resolver that reads them as missing data invents an episode lineup.
    expect(prompt).toMatch(/intentionally empty/);
    expect(prompt).toMatch(/arc, per-character arcs, and volumes only/);
    expect(prompt).toMatch(/Do \*\*not\*\* return an\s+`episodes\[\]` array/);
    // Rule 8 (episode corrections) still ships for the full gate.
    expect(prompt).toMatch(/Correct an episode synopsis when the contradiction/);
  });
});

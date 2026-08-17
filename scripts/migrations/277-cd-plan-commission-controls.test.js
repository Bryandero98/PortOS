import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './277-cd-plan-commission-controls.js';

describe('migration 277 — Creative Director commission controls', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-277-cd-plan-controls-',
  });

  it('keeps the planner anchored to commission and model capabilities', () => {
    const prompt = readFileSync(`${repoRoot}/data.reference/prompts/stages/cd-plan.md`, 'utf8');
    expect(prompt).toContain("authoritative `targetAbility`");
    expect(prompt).toContain('does not expose it in the UI');
    expect(prompt).toContain("snaps them to the selected model's advertised options");
  });
});

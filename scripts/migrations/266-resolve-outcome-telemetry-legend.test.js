import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './266-resolve-outcome-telemetry-legend.js';

describe('migration 266 — resolve-outcome telemetry legend', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-266-resolve-outcome-telemetry-legend-',
  });

  for (const filename of ['pipeline-observer.md', 'pipeline-self-improve.md']) {
    it(`${filename} explains what a resolver attempt's outcome frame carries`, () => {
      const prompt = readFileSync(`${repoRoot}/data.reference/prompts/stages/${filename}`, 'utf8');
      expect(prompt).toContain('resolve:no-change');
      expect(prompt).toContain('noChangeReason');
      // The misreading the frames exist to prevent: a spine round's resolver
      // cannot touch episodes, so a zero there is not evidence of a no-op.
      expect(prompt).toContain('arcSpine');
      expect(prompt).toContain('no-edits-returned');
    });
  }
});

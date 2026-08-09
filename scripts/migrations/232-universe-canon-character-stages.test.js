import { describe } from 'vitest';

import migration from './232-universe-canon-character-stages.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The two Universe Canon character-differentiation stages plus arc auto-resolve.
// All three shipped a template with no stage-config entry, which is exactly what
// the drift catch here guards: `buildPrompt()` resolves stages through
// stage-config, so a template that ships without its entry throws
// "Stage <name> not found" at the button press with nothing failing first.
describe('migration 232 — seed the canon character + arc-resolve stages', () => {
  runSeedStageMigrationTests({
    migration,
    stages: [
      'pipeline-character-refine',
      'pipeline-character-differentiate-cast',
      'pipeline-arc-resolve',
    ],
    prefix: 'migration-232-',
  });
});

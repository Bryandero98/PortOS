import { describe } from 'vitest';

import migration from './286-fableloom-stages.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

// The four FableLoom branching-narrative stages. A template shipped without its
// stage-config entry throws "Stage <name> not found" at the button press with
// nothing failing first — this guards the pair stays complete on upgrades.
describe('migration 286 — seed the FableLoom stages', () => {
  runSeedStageMigrationTests({
    migration,
    stages: [
      'fableloom-weave-episode',
      'fableloom-branch-node',
      'fableloom-play-turn',
      'fableloom-review',
    ],
    prefix: 'migration-286-',
  });
});

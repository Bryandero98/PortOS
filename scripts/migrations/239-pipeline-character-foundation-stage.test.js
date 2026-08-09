import { describe } from 'vitest';

import migration from './239-pipeline-character-foundation-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 239 — seed the character foundation stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['pipeline-character-foundation'],
    prefix: 'migration-239-character-foundation-',
  });
});

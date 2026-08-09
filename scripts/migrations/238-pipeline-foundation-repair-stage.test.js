import { describe } from 'vitest';

import migration from './238-pipeline-foundation-repair-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 238 — seed the foundation repair stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['pipeline-foundation-repair'],
    prefix: 'migration-238-',
  });
});

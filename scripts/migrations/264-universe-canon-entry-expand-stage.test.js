import { describe } from 'vitest';

import migration from './264-universe-canon-entry-expand-stage.js';
import { runSeedStageMigrationTests } from './_seedStageTestHelpers.js';

describe('migration 264 — seed the universe canon place/object expand stage', () => {
  runSeedStageMigrationTests({
    migration,
    stages: ['universe-canon-entry-expand'],
    prefix: 'migration-264-universe-canon-entry-expand-',
  });
});

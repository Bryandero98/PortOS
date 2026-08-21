/**
 * Seed the four FableLoom stages into existing installs.
 *
 * Boot runs migrations (server/index.js) but NOT `setup-data.js`, so an
 * upgrade that pulls + `pm2 restart`s would otherwise leave the new
 * branching-narrative stages unseeded and `runStagedLLM('fableloom-…')`
 * would throw "Stage not found" the first time a weave/branch/play/review
 * call runs.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'fableloom-weave-episode',
  'fableloom-branch-node',
  'fableloom-play-turn',
  'fableloom-review',
]);

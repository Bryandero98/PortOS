/**
 * Seed the character-first Series Autopilot planning stage into existing
 * installs. Custom prompts/config are preserved by the shared seed helper;
 * only missing files and config entries are added.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-character-foundation');

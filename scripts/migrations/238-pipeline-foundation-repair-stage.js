/**
 * Seed the judge-directed Series Autopilot foundation repair stage into
 * existing installs. Custom prompts/config are preserved by the shared seed
 * helper; only missing files and config entries are added.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('pipeline-foundation-repair');

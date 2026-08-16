/**
 * Seed the `universe-canon-entry-expand` stage into existing installs.
 *
 * Boot runs migrations but NOT `setup-data.js`, so an upgrade that pulls +
 * `pm2 restart`s would otherwise leave the new place/object expand stage
 * unseeded — and the quota-burn "describe bible entries" job would throw
 * "Stage not found" the first time it picked a place or an object.
 * Custom prompts/config are preserved by the shared seed helper; only missing
 * files and config entries are added.
 */

import { makeSeedMigration } from './_seedStageHelpers.js';

export default makeSeedMigration('universe-canon-entry-expand');

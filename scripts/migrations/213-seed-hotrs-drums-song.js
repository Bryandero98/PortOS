/**
 * Migration 213 — seed the House of the Rising Sun drum part into existing installs.
 *
 * "House of the Rising Sun" is the SongBook's canonical sample song: migration
 * 190 shipped guitar/piano/ukulele arrangements of it, and #3115 added the
 * `drums` instrument + `drum` grid format. This adds the missing fourth
 * arrangement (`song-seed-hotrs-drums`) so a drummer has the canonical song to
 * play against the other three seeds, rather than only the invented "Example
 * Rock Beat" that exists to demonstrate the format (migration 209).
 *
 * Idempotency, tombstone/edit preservation, the legacy-monolith top-up, and the
 * never-write-over-unreadable-data rule all live in `makeBrainSeedMigration`
 * (`_lib.js`). The seed carries a fixed originInstanceId ('seed') so every
 * install holds a byte-identical record and the brain reconcile checksum still
 * converges across peers.
 */

import { makeBrainSeedMigration } from './_lib.js';

const migration = makeBrainSeedMigration({
  logTag: '🥁 hotrs-drums',
  entityType: 'songs',
  // Only THIS seed id — a later seed addition gets its own migration rather
  // than silently riding along on a re-run of this one.
  seedIds: ['song-seed-hotrs-drums'],
  seedLabel: 'the House of the Rising Sun drum part',
  storeLabel: 'the SongBook',
});

export const { up } = migration;
export default migration;

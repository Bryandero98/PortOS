/**
 * Migration 209 — seed the SongBook drum example groove into existing installs.
 *
 * The `drums` instrument / `drum` content format (#3115) ships one invented
 * example chart ("Example Rock Beat" by The Placeholders) in
 * data.reference/brain/songs.json — it doubles as the format's worked example,
 * so a drummer opening `/songbook` on an upgraded install has something to read,
 * play along with, and copy from.
 *
 * Idempotency, tombstone/edit preservation, the legacy-monolith top-up, and the
 * never-write-over-unreadable-data rule all live in `makeBrainSeedMigration`
 * (`_lib.js`). The seed carries a fixed originInstanceId ('seed') so every
 * install holds a byte-identical record and the brain reconcile checksum still
 * converges across peers.
 */

import { makeBrainSeedMigration } from './_lib.js';

const migration = makeBrainSeedMigration({
  logTag: '🥁 drum-seed',
  entityType: 'songs',
  // Only THIS seed id — a later seed addition gets its own migration rather
  // than silently riding along on a re-run of this one.
  seedIds: ['song-seed-example-rock-beat'],
  seedLabel: 'the drum example groove',
  storeLabel: 'the SongBook',
});

export const { up } = migration;
export default migration;

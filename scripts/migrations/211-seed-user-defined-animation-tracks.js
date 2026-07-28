/**
 * Migration 211 — give existing installs an editable animation-track store.
 *
 * Until #3152, `scanner` and `ambient` were COMPILED rows in
 * `server/services/sprites/animationTracks.js`. They are now ordinary user-defined
 * rows in `data/sprites/animation-tracks.json`, seeded verbatim from
 * `data.reference/sprites/animation-tracks.json` — so a user can retune their
 * bounds, reword their prompts, or delete them outright without a PortOS release.
 * `walk` stays the one mandatory built-in and is deliberately NOT in the store.
 *
 * **The regression this exists to prevent is a silent one.** An install holding an
 * approved scanner set or ambient loop validates that set by its exact `setKind`
 * string (`finalized-eight-direction-scanner-set`), and the runtime-contract Zod
 * schema builds its `scannerFrameCount` / `ambientFrameCount` fields from the
 * effective registry. Without the rows, the compiler would report "unknown
 * animation track 'scanner'" on a record that compiled fine yesterday, and a
 * publish binding pinning `scannerFrameCount` would have that field silently
 * stripped by Zod. So the rows must be present on every upgraded install.
 *
 * **Why this migration is a convenience, not a correctness dependency.** The store
 * falls back to reading `data.reference/sprites/animation-tracks.json` whenever
 * the user copy is absent (see `animationTrackStore.js`) — which is what makes the
 * upgrade safe even on the very first boot, where module load happens before
 * migrations run. This migration's actual job is to materialize an EDITABLE copy
 * under `data/`, so the "Manage animation types" UI (#3153) and a hand-editing
 * user have a file to change. That split is deliberate: correctness never depends
 * on migration ordering, and the user still gets a real file.
 *
 * Idempotent and non-destructive. A store file that already exists is NEVER
 * touched — not merged, not topped up — because a user who deleted `scanner` must
 * have it stay deleted, and a merge would resurrect it on every upgrade. An
 * unreadable existing store is likewise left alone: possibly-recoverable user data
 * beats a clean reseed.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
// `atomicWrite` (ensureDir + temp + rename) rather than mkdir+writeFile, the same
// helper `_seedStageHelpers.js` and 30-odd sibling migrations use. Not cosmetic
// here: a truncated store would make this migration's own existence check report
// `already-present` forever while the store throws "not valid JSON" at module
// load, taking down everything that imports validation.js. It passes a string
// through unchanged, so the seed still lands byte-for-byte.
import { atomicWrite, pathExists } from '../../server/lib/fileUtils.js';

const STORE_REL = join('sprites', 'animation-tracks.json');

export async function up({ rootDir }) {
  const seedPath = join(rootDir, 'data.reference', STORE_REL);
  const storePath = join(rootDir, 'data', STORE_REL);

  // Present in ANY state (valid, empty, corrupt) means the user owns this file —
  // stop. Checked by existence rather than by parsing, because a file that fails
  // to parse is exactly the case where overwriting would destroy user edits.
  if (await pathExists(storePath)) {
    console.log('🎬 animation-tracks: store already present — no-op.');
    return { ok: true, reason: 'already-present' };
  }

  let seed;
  try {
    seed = await readFile(seedPath, 'utf-8');
  } catch (err) {
    // A checkout missing the seed file is a packaging problem, not a data
    // problem: the store's data.reference fallback already covers the runtime, so
    // report and continue rather than failing the whole migration run.
    console.error(`❌ animation-tracks: no seed at data.reference/${STORE_REL} (${err.message}) — skipping.`);
    return { ok: true, reason: 'no-seed' };
  }
  // Parse before writing: shipping a corrupt seed into `data/` would turn the
  // store's "exists but unreadable" throw into a boot failure the user can only
  // fix by deleting a file they never created.
  let parsed;
  try {
    parsed = JSON.parse(seed);
  } catch (err) {
    console.error(`❌ animation-tracks: data.reference/${STORE_REL} is not valid JSON (${err.message}) — skipping.`);
    return { ok: true, reason: 'invalid-seed' };
  }

  await atomicWrite(storePath, seed.endsWith('\n') ? seed : `${seed}\n`);
  const count = Array.isArray(parsed?.tracks) ? parsed.tracks.length : 0;
  console.log(`🎬 animation-tracks: seeded ${count} editable animation ${count === 1 ? 'track' : 'tracks'} into data/${STORE_REL}.`);
  return { ok: true, reason: 'seeded', count };
}

export default { up };

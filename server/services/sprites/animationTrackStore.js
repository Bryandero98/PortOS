/**
 * Sprites — the user-defined animation-track store (issue #3152).
 *
 * #3136 made a track's whole workflow registry DATA — bounds, directionality,
 * on-disk kinds, source reference, prompt — so `animationTrackWorkflow.js` +
 * `POST /:id/tracks/:trackId/{generate,approve}` drive any row without new code.
 * What was still missing is a way for a *user* to add a row: the table was three
 * hardcoded entries, and "a chest opening", "a flower blossoming", or "a jetpack
 * burst" needed a PortOS release. This module is that store, and
 * `getEffectiveAnimationTracks()` is the merged table every registry reader now
 * resolves against.
 *
 * **Why a separate module.** `animationTracks.js` is asserted to be a TRUE LEAF
 * (`animationTracks.test.js`, "keeps animationTracks.js a true leaf") because
 * `server/lib/validation.js` builds its sprite Zod ranges from it and must not
 * drag the native image graph into request validation. A store that reads a file
 * cannot live there. So the dependency runs one way only: this module imports the
 * leaf, never the reverse. It reaches `fileUtils.js` (fs + crypto + path, no
 * native image deps — `validation.js` already imports it), so the sharp-free
 * property that guard actually protects still holds through the merge.
 *
 * **Reads are SYNCHRONOUS, deliberately — and this is the answer to #3152's
 * "lazily-built schema or boot-ordering guarantee" question: NEITHER.** Every
 * registry reader is sync (`getAnimationTrack`, `trackDirections`,
 * `clampTrackFrameCount`) and `server/lib/validation.js` builds
 * `spriteRuntimeContractSchema` from the table at MODULE LOAD. An async store
 * would force one of two bad answers: thread `await` through ~30 pure call sites
 * (including Zod schema construction, which cannot await), or promise that the
 * store is read before validation.js is imported — a guarantee nothing enforces
 * and that ES module hoisting actively breaks, since `server/index.js` imports
 * the whole route graph before it awaits `bootstrapServices`. A `readFileSync` of
 * one small hand-editable config at first use is the same call
 * `lib/curatedGenomeMarkers.js` and `lib/mediaModels.js` already make, costs one
 * stat+read per process, and keeps every existing signature untouched.
 *
 * **The shipped seed is the fallback, so no boot ordering is load-bearing.** When
 * `data/sprites/animation-tracks.json` is ABSENT the store reads
 * `data.reference/sprites/animation-tracks.json` instead. That matters for the
 * upgrade path: module load happens before boot migrations run, so on the first
 * boot after this ships, migration 211 has not yet materialized the user copy —
 * and without the fallback that boot would build a contract schema with no
 * `scannerFrameCount` and refuse to compile an already-approved scanner set. With
 * it, an install sees the seeded rows from the first import onward and the
 * migration's job narrows to giving the user an editable copy. A store file that
 * EXISTS is authoritative and never merged with the seed — that is what lets a
 * user delete `scanner` and have it stay deleted.
 *
 * **`file-primary`, per docs/STORAGE.md.** `data/sprites/animation-tracks.json`
 * is a small, hand-editable, machine-local authoring config that the on-disk
 * sprite tree is meaningless without — a stored row names the `setKind` strings
 * an approved set on THIS machine already carries, so the two travel together or
 * neither means anything. No cross-record queries, no relationships beyond the
 * `kinds` strings, no sync cursor: same class as the LoRA-dataset and MortalLoom
 * stores, and it rides the rsync snapshot rather than a Postgres dump.
 *
 * **A bad stored row fails loudly at LOAD, not at render.** The merged table goes
 * through `assertAnimationTrackRows` — the same guard the compiled table runs at
 * module load — so a row missing a bound, colliding on a contract field, or
 * claiming another track's `setKind` throws here with the field named, instead of
 * surfacing hours later as a `NaN` frame count or one track's finalized set
 * satisfying another's evidence check.
 *
 * **The cache is the restart boundary.** Per #3136/#3152's scope, adding or
 * editing a track takes effect on the next server start. The cache is what makes
 * that explicit rather than accidental: the merge is called on hot paths (every
 * generate, every compile, every route resolve) and re-reading the file each time
 * would make the registry silently mutable mid-request — a compile could then
 * validate spans against a table the render that produced them never saw.
 * `__resetAnimationTrackStore()` exists for tests and for the CRUD UI (#3153) to
 * invalidate after a write. `null` = not loaded, `{}` = loaded and legitimately
 * empty, so a zero-row install caches instead of re-reading on every lookup.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { ANIMATION_TRACKS, WALK_TRACK, assertAnimationTrackRows } from './animationTracks.js';

/** The store file, relative to `data/` (and to `data.reference/` for the seed). */
export const ANIMATION_TRACK_STORE_REL = 'sprites/animation-tracks.json';
/** The store's on-disk layout version (distinct from any per-row shape version). */
export const ANIMATION_TRACK_STORE_SCHEMA_VERSION = 1;

/** The user-owned store — authoritative when it exists. */
export const animationTrackStorePath = () => join(PATHS.data, ANIMATION_TRACK_STORE_REL);
/** The shipped seed, read only when the user copy is absent (see the header). */
export const animationTrackSeedPath = () => join(PATHS.root, 'data.reference', ANIMATION_TRACK_STORE_REL);

// `null` = not read yet; `{}` = read and empty. See the header's sentinel note.
let cachedStoredRows = null;
// The merged table, memoized alongside the rows so `assertAnimationTrackRows`
// runs once per process rather than on every registry lookup.
let cachedEffectiveTracks = null;

/**
 * Read one candidate store file. Returns `null` for "not there" (try the next
 * candidate) and THROWS for "there but unreadable" — the sentinel rule: a
 * corrupt store must not silently degrade to the seed, or a user whose edits
 * broke the JSON would see their tracks quietly revert to shipped defaults with
 * no error to explain it.
 */
function readStoreDoc(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new Error(`${ANIMATION_TRACK_STORE_REL}: cannot read ${path} — ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ANIMATION_TRACK_STORE_REL}: ${path} is not valid JSON — ${err.message}`);
  }
}

/**
 * Freeze one raw stored row into the exact shape a compiled row has, with
 * `builtin: false` forced.
 *
 * Forced rather than read: a stored row claiming `builtin: true` would pass the
 * "builtin rows carry no promptTemplate" guard by shedding its own prompt and
 * then throw at generate time with no builder to fall back to. Where a row came
 * from is a fact about the store, not a field the store's contents get a vote on.
 */
const normalizeStoredRow = (raw) => Object.freeze({
  ...raw,
  kinds: Object.freeze([...(Array.isArray(raw?.kinds) ? raw.kinds : [])]),
  builtin: false,
});

/**
 * The user-defined rows, keyed by id — `{}` when neither the store nor the seed
 * exists, or when the resolved file holds no `tracks` array.
 */
function loadStoredRows() {
  if (cachedStoredRows) return cachedStoredRows;
  const doc = readStoreDoc(animationTrackStorePath()) ?? readStoreDoc(animationTrackSeedPath());
  const rows = Array.isArray(doc?.tracks) ? doc.tracks : [];
  const byId = {};
  for (const raw of rows) {
    const id = raw?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error(`${ANIMATION_TRACK_STORE_REL}: every stored track needs a non-empty string id`);
    }
    // Shadowing `walk` would replace the one mandatory built-in through a data
    // edit — its bounds feed the Zod schemas and its `setKind` gates every
    // character compile, so a store row could brick authoring with no code change
    // to point at. Refuse it by name rather than letting the spread decide.
    if (id === WALK_TRACK) {
      throw new Error(`${ANIMATION_TRACK_STORE_REL}: '${WALK_TRACK}' is the mandatory built-in track and cannot be redefined by a stored row`);
    }
    if (byId[id]) throw new Error(`${ANIMATION_TRACK_STORE_REL}: track '${id}' is defined twice`);
    byId[id] = normalizeStoredRow(raw);
  }
  cachedStoredRows = Object.freeze(byId);
  return cachedStoredRows;
}

/**
 * The compiled table merged with the user-defined store: `{ walk, …stored }`.
 *
 * Registration order puts `walk` first, which is what keeps every derived
 * ordering (the atlas span order, the effective id list) byte-stable across
 * installs regardless of what the user has added.
 *
 * Validated as a WHOLE table, not row by row: the invariants that matter most
 * here are cross-row (two tracks claiming one contract field or one `setKind`, or
 * a record kind ending up with two standalone baselines), and a per-row check
 * would miss every one of them.
 */
export function getEffectiveAnimationTracks() {
  if (cachedEffectiveTracks) return cachedEffectiveTracks;
  const merged = Object.freeze({ ...ANIMATION_TRACKS, ...loadStoredRows() });
  assertAnimationTrackRows(merged);
  cachedEffectiveTracks = merged;
  return merged;
}

/** Effective track ids, in registration order (`walk` first, then stored). */
export function getEffectiveAnimationTrackIds() {
  return Object.keys(getEffectiveAnimationTracks());
}

/**
 * Drop the cached store read.
 *
 * For tests, and for the CRUD UI (#3153) to call after it writes — a write that
 * left the cache standing would report success while the running server kept
 * serving the old table.
 */
export function __resetAnimationTrackStore() {
  cachedStoredRows = null;
  cachedEffectiveTracks = null;
}

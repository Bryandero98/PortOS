/**
 * Sprites — the animation-track registry (issue #3015).
 *
 * Frame-count and fps bounds used to be GLOBAL and walk-shaped: one 6–16 /
 * 4–24 range applied to every animation, because the walk cycle was the only
 * animation that existed. #2985 made the persisted target *track-keyed*
 * (`animationTargets.walk`), but nothing described what tracks exist or what
 * each one's legal range is — so a 3-frame ambient loop (a tree in the wind) or
 * a 4-frame scanner action was unrepresentable: both sit BELOW walk's floor.
 *
 * This module is that description. One row per known track carries its own
 * bounds, defaults, directionality, and the `runtimeContract` field names it
 * occupies — so adding a track is a row here plus its pipeline, never a hunt
 * for hard-coded 6/16 literals. `walk` is the first and (today) only row and
 * reproduces its historical values exactly; `walkBounds.js` now re-reads this
 * row rather than defining the range itself.
 *
 * **Sharp-free leaf, deliberately.** `server/lib/validation.js` builds its Zod
 * ranges from these rows and must not drag the native image graph
 * (sharp/ffmpeg, via walkPostprocess) into the request-validation graph — the
 * same split walkBounds.js was created for, now one level deeper. This module
 * imports NOTHING. `animationTracks.test.js` asserts that transitively.
 *
 * **Unknown track ids are an error, not a fallback.** `getAnimationTrack('nope')`
 * throws instead of quietly handing back walk's range — a mis-keyed track that
 * silently validated against walk's 6–16 would let a 4-frame action be rejected
 * for reasons no message explains. Absent (`undefined`/`null`) means "the
 * default track" and resolves to `walk`, which is what preserves every existing
 * call site; an empty string is *present and invalid*, so it throws.
 */

/** The default track — the only one that exists today. */
export const WALK_TRACK = 'walk';

/**
 * Every known animation track.
 *
 * - `minFrameCount` / `maxFrameCount` — the authoring range the packer clamps
 *   into and the Zod schemas range-check against.
 * - `defaultFrameCount` / `defaultFps` — the bottom rung of the target
 *   precedence chain (see `animationTargets.js`).
 * - `directional` — true when the track occupies one atlas ROW per facing
 *   (walk: 8 directions); a future ambient loop would be false (one row).
 * - `contractFrameCountField` / `contractFpsField` — the field names this track
 *   occupies in an app's `publishBinding.runtimeContract` (#2982). Named here so
 *   the app rung of the precedence chain is track-driven rather than hard-coded
 *   to `walkFrameCount`. `contractFpsField` may be `null` for a track whose
 *   speed an app has no say in.
 */
export const ANIMATION_TRACKS = Object.freeze({
  [WALK_TRACK]: Object.freeze({
    id: WALK_TRACK,
    label: 'Walk cycle',
    directional: true,
    minFrameCount: 6,
    maxFrameCount: 16,
    defaultFrameCount: 12,
    minFps: 4,
    maxFps: 24,
    defaultFps: 10,
    contractFrameCountField: 'walkFrameCount',
    // `spriteRuntimeContractSchema` deliberately declares no fps key (a
    // distance-driven consumer has no animation-fps concept), so today this is
    // reachable only by a legacy/hand-built contract object — kept, not
    // nulled, because dropping it would change resolution behavior for those.
    // A second track copying this row should decide its own answer.
    contractFpsField: 'walkFps',
  }),
});

/** Known track ids, in registry order. */
export const ANIMATION_TRACK_IDS = Object.freeze(Object.keys(ANIMATION_TRACKS));

// Fail fast at module load, the way navManifest.js and catalogTypes.js guard
// their registries: a row missing a bound would otherwise boot clean and
// surface much later as `NaN` out of a Math.min, or as `z.number().min(
// undefined)` throwing at the first sprite render. A bad row should block boot
// with a message naming the field, not corrupt a render hours later.
const claimedContractFields = new Map();
for (const id of ANIMATION_TRACK_IDS) {
  const row = ANIMATION_TRACKS[id];
  if (row.id !== id) throw new Error(`animationTracks: row '${id}' declares mismatched id '${row.id}'`);
  if (typeof row.label !== 'string' || !row.label) throw new Error(`animationTracks: track '${id}' needs a label`);
  if (typeof row.directional !== 'boolean') throw new Error(`animationTracks: track '${id}' needs a boolean 'directional'`);
  for (const field of ['minFrameCount', 'maxFrameCount', 'defaultFrameCount', 'minFps', 'maxFps', 'defaultFps']) {
    if (!Number.isInteger(row[field])) throw new Error(`animationTracks: track '${id}' needs an integer '${field}'`);
  }
  if (typeof row.contractFrameCountField !== 'string' || !row.contractFrameCountField) {
    throw new Error(`animationTracks: track '${id}' needs a contractFrameCountField`);
  }
  if (row.contractFpsField !== null && (typeof row.contractFpsField !== 'string' || !row.contractFpsField)) {
    throw new Error(`animationTracks: track '${id}' needs a contractFpsField (or null)`);
  }
  for (const [min, def, max] of [
    ['minFrameCount', 'defaultFrameCount', 'maxFrameCount'],
    ['minFps', 'defaultFps', 'maxFps'],
  ]) {
    if (!(row[min] <= row[def] && row[def] <= row[max])) {
      throw new Error(`animationTracks: track '${id}' needs ${min} <= ${def} <= ${max}`);
    }
  }
  // Two tracks must not claim the same runtimeContract field. The anticipated
  // failure is a second row copy-pasted from walk's: `resolveAnimationTarget`
  // would then read the WALK's `walkFrameCount` for the scanner and, whenever
  // that value happens to land inside the scanner's range, return it with
  // `frameCountLocked: true` — silently pinning one track to another's contract
  // and throwing a lock error citing a binding that never mentioned it.
  for (const field of [row.contractFrameCountField, row.contractFpsField]) {
    if (field === null) continue;
    const owner = claimedContractFields.get(field);
    if (owner) {
      throw new Error(`animationTracks: contract field '${field}' is claimed by both '${owner}' and '${id}'`);
    }
    claimedContractFields.set(field, id);
  }
}

/** True when `id` names a track this build knows. */
export function isAnimationTrack(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(ANIMATION_TRACKS, id);
}

/**
 * The registry row for `id`. Absent (`undefined`/`null`) resolves to the default
 * track; anything else unrecognized THROWS rather than falling back, so a typo
 * can never be validated against walk's range by accident.
 */
export function getAnimationTrack(id) {
  const key = id === undefined || id === null ? WALK_TRACK : id;
  if (!isAnimationTrack(key)) {
    throw new Error(
      `Unknown animation track '${String(key)}' — known tracks: ${ANIMATION_TRACK_IDS.join(', ')}.`,
    );
  }
  return ANIMATION_TRACKS[key];
}

// Round-then-clamp, with unusable input (NaN, non-numeric) falling back to the
// knob's default rather than to a bound — the two knobs differ only in which
// three row fields they read.
const clampInto = (n, min, max, fallback) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
};

/** Clamp a requested frame count into `track`'s authoring range. */
export function clampTrackFrameCount(n, track) {
  const row = getAnimationTrack(track);
  return clampInto(n, row.minFrameCount, row.maxFrameCount, row.defaultFrameCount);
}

/** Clamp a requested playback fps into `track`'s authoring range. */
export function clampTrackFps(n, track) {
  const row = getAnimationTrack(track);
  return clampInto(n, row.minFps, row.maxFps, row.defaultFps);
}

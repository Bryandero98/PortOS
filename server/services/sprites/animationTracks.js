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
 *   to `walkFrameCount`.
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
    contractFpsField: 'walkFps',
  }),
});

/** Known track ids, in registry order. */
export const ANIMATION_TRACK_IDS = Object.freeze(Object.keys(ANIMATION_TRACKS));

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

/** Clamp a requested frame count into `track`'s authoring range. */
export function clampTrackFrameCount(n, track) {
  const row = getAnimationTrack(track);
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return row.defaultFrameCount;
  return Math.max(row.minFrameCount, Math.min(row.maxFrameCount, v));
}

/** Clamp a requested playback fps into `track`'s authoring range. */
export function clampTrackFps(n, track) {
  const row = getAnimationTrack(track);
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return row.defaultFps;
  return Math.max(row.minFps, Math.min(row.maxFps, v));
}

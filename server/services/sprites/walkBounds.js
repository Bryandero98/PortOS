/**
 * Sprites — walk-cycle authoring bounds + pure label/clamp helpers.
 *
 * A dependency-free leaf module (NO sharp/ffmpeg) so both the deterministic
 * packer (walkPostprocess.js, which imports sharp) AND the request-validation
 * layer (server/lib/validation.js) can share ONE definition of the frame-count
 * / playback-fps range. Keeping these in walkPostprocess would drag its native
 * image graph into the validation graph; duplicating them as literals in the
 * Zod schema let the schema and the server-side clamp silently diverge. This
 * module is the single source of truth for both — see the recordsLogic.js
 * sharp-free split for the same pattern.
 *
 * Since #3015 the *numbers* live one level deeper, in the per-track registry
 * (`animationTracks.js`), because a range that applies to every animation is
 * walk-shaped by construction — a 4-frame scanner action sits below walk's
 * floor of 6. What remains here is the WALK view of that registry: the exports
 * below are thin re-reads of the `walk` row, kept so every existing importer
 * (walkPostprocess, atlas, walk, validation, the client mirror) needs no churn.
 * New track-aware code should reach for `animationTracks.js` directly.
 */

import {
  WALK_TRACK, getAnimationTrack, clampTrackFrameCount, clampTrackFps,
} from './animationTracks.js';

const WALK = getAnimationTrack(WALK_TRACK);

// Source-pipeline gait phases (the historical 8-frame packing). Part of the
// cross-install artifact contract — imported manifests carry these exact labels.
export const WALK_PHASES = [
  'left-contact', 'left-down', 'left-passing', 'left-up',
  'right-contact', 'right-down', 'right-passing', 'right-up',
];

// Legacy default / fallback frame count for manifests (or clients) that omit it.
export const WALK_FRAME_COUNT = 8;

// The non-walk columns of the runtime atlas grid, named once so the compiler
// that WRITES them (atlas.js `atlasColumns`) and the layout sidecar that
// DESCRIBES them (atlasLayout.js) can never disagree on a column's identity —
// the same reason walkPhaseLabels lives here. `scanner` is READ-ONLY now: the
// compiler stopped emitting that duplicate-of-idle column (#2986), but
// imported/pre-#2986 grids still carry it, so the sidecar must keep
// recognizing it by name.
export const ATLAS_IDLE_COLUMN = 'idle';
export const ATLAS_SCANNER_COLUMN = 'scanner';

// Configurable authoring range (#sprite-walk-variable-frames), read from the
// walk row of the track registry (#3015) rather than restated here. The packer
// resamples the detected gait window DOWN to `frameCount` distinct source frames
// (never upsamples), and playback fps is metadata — so a slower/smoother walk
// needs no regeneration, only a reprocess of the on-disk clip at a new count/fps.
export const WALK_DEFAULT_FRAME_COUNT = WALK.defaultFrameCount;
export const WALK_DEFAULT_FPS = WALK.defaultFps;
export const WALK_MIN_FRAME_COUNT = WALK.minFrameCount;
export const WALK_MAX_FRAME_COUNT = WALK.maxFrameCount;
export const WALK_MIN_FPS = WALK.minFps;
export const WALK_MAX_FPS = WALK.maxFps;

/**
 * Column/phase labels for an N-frame packed strip. The historical 8-frame
 * packing keeps its named 2-beat gait phases (so existing atlases and imported
 * manifests round-trip byte-identically); any other length uses positional
 * `frame-NN` labels. Postprocess (which writes them) and atlas.js (which
 * asserts them) MUST derive labels through this one helper so they can never
 * disagree on a column's identity.
 */
export function walkPhaseLabels(n) {
  if (n === WALK_PHASES.length) return [...WALK_PHASES];
  return Array.from({ length: n }, (_, i) => `frame-${String(i).padStart(2, '0')}`);
}

/** Clamp a requested frame count into the WALK track's authoring range. */
export function clampFrameCount(n) {
  return clampTrackFrameCount(n, WALK_TRACK);
}

/** Clamp a requested playback fps into the WALK track's authoring range. */
export function clampFps(n) {
  return clampTrackFps(n, WALK_TRACK);
}

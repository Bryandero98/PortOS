/**
 * Per-track image-to-video prompt resolution (#3136).
 *
 * The generic animation workflow needs ONE call that answers "what do I send the
 * provider for this track?" — because that question is the last thing that was
 * still track-specific code rather than track-specific data. Today the answer is
 * a lookup into the builders `prompts.js` already owns; when a user-defined
 * track store lands, an unknown id resolves to that track's stored
 * `promptTemplate` here instead of throwing, and no caller changes.
 *
 * Kept separate from `prompts.js` deliberately: that module is the pure catalog
 * of prompt TEXT (and its tests assert the exact wording of each stage), while
 * this is the small dispatch layer over it. Folding the dispatch in would make
 * every prompt-wording test also a routing test.
 *
 * Pure — no I/O, no state.
 */

import { buildWalkVideoPrompt, buildScannerPrompt, buildAmbientVideoPrompt } from './prompts.js';
import { WALK_TRACK, SCANNER_TRACK, AMBIENT_TRACK } from './animationTracks.js';

/**
 * The i2v prompt builder for each track compiled into this build.
 *
 * Every builder takes the same superset argument object and reads only what it
 * needs, so the dispatch below passes one shape and never has to know which
 * fields a given track's wording happens to embed.
 */
const TRACK_VIDEO_PROMPTS = Object.freeze({
  [WALK_TRACK]: buildWalkVideoPrompt,
  [SCANNER_TRACK]: buildScannerPrompt,
  [AMBIENT_TRACK]: buildAmbientVideoPrompt,
});

/**
 * The image-to-video instruction for one track's render.
 *
 * Throws on an unregistered track rather than falling back to walk's wording —
 * the same unknown-id boundary `getAnimationTrack` draws, and for the same
 * reason: a mis-keyed track that silently sent the walk prompt would render a
 * gait loop and pass every later check, since nothing downstream re-reads what
 * was asked for.
 */
export function buildTrackVideoPrompt(trackId, args) {
  const build = TRACK_VIDEO_PROMPTS[trackId];
  if (!build) {
    throw new Error(
      `No image-to-video prompt is registered for animation track '${String(trackId)}' `
      + `— known tracks: ${Object.keys(TRACK_VIDEO_PROMPTS).join(', ')}.`,
    );
  }
  return build(args);
}

/** True when `trackId` has a registered i2v prompt builder. */
export const hasTrackVideoPrompt = (trackId) =>
  Object.prototype.hasOwnProperty.call(TRACK_VIDEO_PROMPTS, trackId);

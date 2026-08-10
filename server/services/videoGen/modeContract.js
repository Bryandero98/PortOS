/**
 * Video Gen — per-model input contracts, as pure rule tables.
 *
 * Every one of these rules has to hold at TWO boundaries: `prepareParams.js`
 * rejects before the request is persisted to the media job queue, and
 * `local.js` rejects again at the render boundary (internal producers,
 * persisted-queue replays and retries all reach `generateVideo` directly).
 * Checking twice is deliberate — see the a2v and wan22 precedents in
 * `prepareParams.js` — but *stating* the rule twice is how the two ends drift
 * into different messages and different error codes for the same request.
 *
 * So the rules live here, return a `ServerError` (or null) rather than throwing,
 * and each caller decides only what to do first: the route unlinks its staged
 * uploads, the render path just throws.
 *
 * Dependency-free apart from the error leaf, which keeps it importable from
 * `prepareParams.js` without dragging in `local.js` — the module suites mock
 * `local.js` wholesale, and a mocked rule table is no rule table at all.
 *
 * Careful: `mode` here is the t2v/i2v *semantic* ('text' | 'image' | 'fflf' |
 * 'a2v' | 'extend' | an IC-LoRA remix id), not the local/grok render backend
 * that `modes.js` enumerates.
 *
 * DO NOT add a third runtime's mode gate as another near-copy of the H3 table
 * below — wan22's copy in `prepareParams.js` plus this one is already two, and
 * they have drifted. Issue #3736 collapses them into one `supportedModes`-driven
 * contract; a third runtime should land on that instead.
 */

import { ServerError } from '../../lib/errorHandler.js';

// H3's fl2va path conditions on up to two keyframes anchored at the first and
// last latent frame — so text, image (first only) and FFLF (first + last) all
// run, while extend / a2v / IC-remix and the ltx2 multi-keyframe array (which
// pins arbitrary frame indices H3 has no anchor for) still have no equivalent.
export const MINIMAX_H3_MODES = Object.freeze(['text', 'image', 'fflf']);

/**
 * The MiniMax H3 input contract. Returns a ServerError to throw, or null when
 * the request is legal.
 *
 * `supportedModes` comes off the registry entry so the picker and the API agree
 * even on an install whose `data/media-models.json` was hand-edited or narrowed;
 * `MINIMAX_H3_MODES` stays the ceiling, because an entry can't declare a mode
 * the helper has no arguments for.
 */
export const miniMaxH3InputError = ({
  mode,
  hasFirstImage,
  hasLastImage,
  supportedModes = null,
  keyframes = null,
  extendFromVideo = null,
  audioFile = null,
  audioStartSec = null,
  icReferences = null,
}) => {
  const requestedMode = mode || (hasFirstImage ? 'image' : 'text');
  const allowedModes = Array.isArray(supportedModes)
    ? supportedModes.filter((m) => MINIMAX_H3_MODES.includes(m))
    : MINIMAX_H3_MODES;
  const hasIcReferences = Array.isArray(icReferences) ? icReferences.length > 0 : icReferences != null;
  const fail = (message, code) => new ServerError(message, { status: 400, code });
  if (
    !allowedModes.includes(requestedMode)
    || (Array.isArray(keyframes) ? keyframes.length > 0 : keyframes != null)
    || extendFromVideo
    || audioFile
    || audioStartSec != null
    || hasIcReferences
  ) {
    return fail(
      `MiniMax H3 MLX supports ${allowedModes.join(', ') || 'no'} modes only; remove multi-keyframe, video, audio, or reference conditioning.`,
      'MINIMAX_H3_MODE_UNSUPPORTED',
    );
  }
  // Each mode has exactly one legal image shape. Silently dropping (or silently
  // adding) a keyframe would render a materially different clip than asked for.
  if (requestedMode === 'text' && (hasFirstImage || hasLastImage)) {
    return fail(
      'MiniMax H3 text-to-video cannot consume a conditioning image — switch to image or FFLF mode.',
      'MINIMAX_H3_TEXT_MODE_SOURCE_CONFLICT',
    );
  }
  if (requestedMode === 'image' && !hasFirstImage) {
    return fail(
      'MiniMax H3 image-to-video requires a source image — choose an existing gallery image or upload one.',
      'MINIMAX_H3_I2V_REQUIRES_IMAGE',
    );
  }
  if (requestedMode === 'image' && hasLastImage) {
    return fail(
      'MiniMax H3 image-to-video takes a single first-frame image — switch to FFLF mode to use a last frame.',
      'MINIMAX_H3_I2V_LAST_IMAGE_CONFLICT',
    );
  }
  if (requestedMode === 'fflf' && !hasFirstImage && !hasLastImage) {
    return fail(
      'MiniMax H3 FFLF requires a first and/or last frame image.',
      'MINIMAX_H3_FFLF_REQUIRES_IMAGE',
    );
  }
  return null;
};

/**
 * Chunk chaining seeds chunk N+1 from chunk N's extracted last frame, so it
 * needs image-to-video on any runtime. Returns a ServerError for a model that
 * lacks it, else null.
 *
 * An entry with no declared `supportedModes` is permitted — unset means
 * "unconstrained", not "text-only" — and both boundaries must read it that way,
 * which is why this is one function rather than a rule re-typed per runtime.
 */
export const videoChainUnsupportedError = (model) => {
  if (!Array.isArray(model?.supportedModes) || model.supportedModes.includes('image')) return null;
  return new ServerError(
    `${model.name} cannot generate chunks > 1 because continuation requires image-to-video support.`,
    {
      status: 400,
      code: model.runtime === 'wan22'
        ? 'WAN22_CHAIN_REQUIRES_IMAGE_MODE'
        : 'VIDEO_CHAIN_REQUIRES_IMAGE_MODE',
    },
  );
};

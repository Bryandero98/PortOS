/**
 * Frame-quality scoring — picks the video continuation anchor by measuring
 * candidate frames instead of trusting wherever an end-seek happens to land.
 *
 * A chained render conditions chunk N+1 on ONE frame taken from the tail of
 * chunk N. Local video output is motion-heavy by construction (the prompt
 * guidance explicitly asks for a camera move and a visible action), so that
 * frame is frequently motion-blurred, mid-blink, or inside a fade — and the
 * next chunk inherits the blur as the scene's actual content, compounding
 * through every subsequent hop.
 *
 * The scoring is deliberately cheap and dependency-free beyond `sharp` (already
 * a server dependency): decode each candidate to a raw single-channel buffer,
 * then combine three terms.
 *
 *   focus     — log-compressed variance of the first-difference gradient.
 *               Log compression is what keeps one exceptionally sharp frame
 *               from swamping the exposure term.
 *   exposure  — penalty on the distance of mean luma from mid-grey, which is
 *               what rejects a frame inside a fade-to-black or a blown highlight.
 *   recency   — a small linear preference for later frames, so among
 *               comparably clean candidates the anchor stays as close to the
 *               cut as possible. Without it the scorer drifts toward the calm
 *               middle of the window and continuity loosens.
 *
 * `quality` (focus − exposure) is what the usability floor tests, NOT `score`
 * — otherwise the free recency bonus on the last candidate could lift a black
 * frame over the floor.
 */

import sharp from 'sharp';

// Tail window the candidates are decoded from, and how densely. ~12 frames
// across the final 1.75s: dense enough that a blur burst doesn't cover every
// candidate, sparse enough that the decode stays well under a second.
export const TAIL_WINDOW_SECONDS = 1.75;
export const CANDIDATE_FPS = 7;
export const MAX_CANDIDATES = 12;

// Gradient variance that maps to a focus of 1.0. Real sharp frames land in the
// low thousands, so this leaves headroom without clamping ordinary content.
export const FOCUS_SCALE = 20000;
export const EXPOSURE_WEIGHT = 0.6;
export const RECENCY_WEIGHT = 0.15;
// Below this, the whole tail is unusable (black, or uniformly featureless) and
// the caller should degrade rather than anchor on it.
export const USABLE_QUALITY_FLOOR = 0.05;

const clamp01 = (n) => (n < 0 ? 0 : (n > 1 ? 1 : n));

const isFrame = (frame) => !!frame
  && Number.isInteger(frame.width) && Number.isInteger(frame.height)
  && frame.width > 0 && frame.height > 0
  && frame.data?.length >= frame.width * frame.height;

/**
 * Variance of the horizontal + vertical first differences over a raw
 * single-channel buffer. Higher = sharper. Both difference sets are pooled
 * into one sample population so a frame blurred along only one axis (the
 * common camera-pan case) still scores low.
 */
export function gradientVariance(frame) {
  if (!isFrame(frame)) return 0;
  const { width, height, data } = frame;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (x + 1 < width) {
        const dx = data[i + 1] - data[i];
        sum += dx; sumSq += dx * dx; n++;
      }
      if (y + 1 < height) {
        const dy = data[i + width] - data[i];
        sum += dy; sumSq += dy * dy; n++;
      }
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/** Mean luma of a raw single-channel buffer, normalized to 0..1. */
export function meanLuma(frame) {
  if (!isFrame(frame)) return 0;
  const { width, height, data } = frame;
  const count = width * height;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += data[i];
  return sum / count / 255;
}

/**
 * Score one decoded frame. `recency` is 0 for the oldest candidate in the
 * window and 1 for the newest; a single candidate is treated as newest.
 *
 * Returns every component, not just the total, so a caller can log WHY a tail
 * was rejected instead of just that it was.
 */
export function scoreFrame(frame, { recency = 1 } = {}) {
  const variance = gradientVariance(frame);
  const focus = clamp01(Math.log1p(variance) / Math.log1p(FOCUS_SCALE));
  const luma = meanLuma(frame);
  // Distance from mid-grey, normalized so pure black and pure white both hit 1.
  const exposurePenalty = clamp01(Math.abs(luma - 0.5) / 0.5);
  const r = clamp01(Number.isFinite(recency) ? recency : 0);
  const quality = focus - EXPOSURE_WEIGHT * exposurePenalty;
  return {
    focus,
    luma,
    exposurePenalty,
    recency: r,
    quality,
    score: quality + RECENCY_WEIGHT * r,
    usable: quality >= USABLE_QUALITY_FLOOR,
  };
}

/**
 * Decode an image file to a raw greyscale frame. Returns null on ANY decode
 * failure — a candidate ffmpeg wrote partially (or not at all) is simply not a
 * candidate, and must never abort a render the user already paid GPU time for.
 */
export async function decodeGreyscaleFrame(path, { sharpImpl = sharp } = {}) {
  const decoded = await sharpImpl(path).greyscale().raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  if (!decoded?.info) return null;
  const { width, height } = decoded.info;
  const frame = { width, height, data: decoded.data };
  return isFrame(frame) ? frame : null;
}

/**
 * Score every candidate path (given in timeline order, oldest first) and
 * return the best one, or null when nothing decoded or nothing clears the
 * usability floor. The returned `index` is the candidate's position in the
 * input array, which is what lets the caller name the offset it picked.
 */
export async function pickBestFrame(paths, { sharpImpl = sharp } = {}) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
  if (!list.length) return null;
  let best = null;
  // Decoded sequentially on purpose: only the SCORE outlives each frame, so
  // one raw buffer is live at a time. Decoding the whole window at once would
  // hold width × height bytes per candidate simultaneously, which scales with
  // the render resolution for no wall-clock that matters next to a GPU render.
  for (let i = 0; i < list.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const frame = await decodeGreyscaleFrame(list[i], { sharpImpl });
    if (!frame) continue;
    const recency = list.length === 1 ? 1 : i / (list.length - 1);
    const scored = scoreFrame(frame, { recency });
    if (!scored.usable) continue;
    if (!best || scored.score > best.score) best = { path: list[i], index: i, ...scored };
  }
  return best;
}

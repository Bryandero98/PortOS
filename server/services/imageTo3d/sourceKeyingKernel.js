/**
 * Sharp-free image-to-3D background-keying kernel.
 *
 * The worker imports this leaf directly so a render does not load the
 * sharp/file-I/O boundary in a fresh thread. `sourceKeying.js` re-exports the
 * public kernel functions for the existing service/test import surface.
 */

import {
  detectSolidBorderColor as detectSolidBorderColorShared,
  getBorderBandOffsets,
} from '../../lib/borderKey.js';

/** Euclidean RGB distance for the border/flood match (0–441 scale). */
export const KEY_TOLERANCE = 30;
/** Tighter distance for enclosed pockets that can't be reached from the border. */
export const KEY_TIGHT_TOLERANCE = 15;
/** Minimum fraction of border pixels that must match for "solid background". */
export const KEY_MIN_BORDER_COVERAGE = 0.9;
/** Distance band past KEY_TOLERANCE that maps to partial alpha at the edge. */
export const KEY_SOFT_BAND = 30;
/** Keyed-area fraction outside (min, max) means the detection was wrong. */
export const KEY_MIN_KEYED_RATIO = 0.05;
export const KEY_MAX_KEYED_RATIO = 0.98;

const KEY_TOLERANCE_SQ = KEY_TOLERANCE ** 2;
const KEY_TIGHT_TOLERANCE_SQ = KEY_TIGHT_TOLERANCE ** 2;

const distSq = (data, i, [r, g, b]) => (
  (data[i] - r) ** 2 + (data[i + 1] - g) ** 2 + (data[i + 2] - b) ** 2
);

/**
 * Detect the image-to-3D background with the shared band sampler. The
 * image-to-3D lane intentionally adopts the sprite lane's robust band policy;
 * its flood seeds use the same offsets so measurement and keying agree.
 */
export function detectSolidBorderColor({ data, width, height }) {
  return detectSolidBorderColorShared(
    { data, width, height },
    { tolerance: KEY_TOLERANCE, minCoverage: KEY_MIN_BORDER_COVERAGE },
  );
}

/**
 * Key a solid background out of a raw RGBA buffer. Pure — returns a NEW buffer
 * plus stats, or null when the image has no detectable solid background (or the
 * detection failed its own sanity gates).
 */
export function keySolidBackground({ data, width, height }) {
  const background = detectSolidBorderColor({ data, width, height });
  if (!background) return null;

  const pixelCount = width * height;
  const keyed = new Uint8Array(pixelCount); // 1 = background
  const queue = new Int32Array(pixelCount);
  let queueLength = 0;

  const enqueue = (p) => {
    if (!keyed[p] && distSq(data, p * 4, background) <= KEY_TOLERANCE_SQ) {
      keyed[p] = 1;
      queue[queueLength] = p;
      queueLength += 1;
    }
  };
  for (const offset of getBorderBandOffsets({ width, height })) enqueue(offset / 4);

  for (let head = 0; head < queueLength; head += 1) {
    const p = queue[head];
    const x = p % width;
    if (x > 0) enqueue(p - 1);
    if (x < width - 1) enqueue(p + 1);
    if (p >= width) enqueue(p - width);
    if (p < pixelCount - width) enqueue(p + width);
  }

  // Enclosed pockets: background color trapped between limbs never touches the
  // border, so the flood can't reach it — key it only on the tight tolerance.
  let keyedCount = queueLength;
  for (let p = 0; p < pixelCount; p += 1) {
    if (!keyed[p] && distSq(data, p * 4, background) <= KEY_TIGHT_TOLERANCE_SQ) {
      keyed[p] = 1;
      keyedCount += 1;
    }
  }

  const keyedRatio = keyedCount / pixelCount;
  if (keyedRatio < KEY_MIN_KEYED_RATIO || keyedRatio > KEY_MAX_KEYED_RATIO) return null;

  const out = new Uint8Array(data.length);
  out.set(data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (keyed[p]) { out[p * 4 + 3] = 0; continue; }
      // Feather only against pixels that actually border the keyed region — a
      // background-adjacent edge texel carrying spill gets partial alpha; interior
      // pixels that merely resemble the background stay fully opaque.
      const touchesKeyed = (x > 0 && keyed[p - 1]) || (x < width - 1 && keyed[p + 1])
        || (y > 0 && keyed[p - width]) || (y < height - 1 && keyed[p + width]);
      if (!touchesKeyed) continue;
      const d = Math.sqrt(distSq(data, p * 4, background));
      if (d < KEY_TOLERANCE + KEY_SOFT_BAND) {
        out[p * 4 + 3] = Math.max(0, Math.round(((d - KEY_TOLERANCE) / KEY_SOFT_BAND) * 255));
      }
    }
  }
  return { data: out, background, keyedRatio };
}

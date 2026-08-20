/**
 * Solid-background keying for image-to-3D source images.
 *
 * TRELLIS.2's own preprocessing uses a real alpha channel directly when one is
 * present and only falls back to RMBG-2.0 matting when there isn't — and matting a
 * flat green/blue screen is exactly where it produces soft, uncertain mattes (color
 * spill, fuzzy fur edges) that turn into hallucinated geometry. When the user's
 * source has NO alpha but sits on a detectably solid background, PortOS can key it
 * deterministically before the render and hand the pipeline a real alpha channel.
 *
 * The pixel work is pure (raw RGBA buffers in/out) so it's unit-testable on tiny
 * synthetic images; `prepareSourceImage` is the one sharp/file boundary. The keyed
 * copy is written into the RECORD's render directory — the shared gallery file is
 * never mutated (other features reference it).
 *
 * A deliberately simpler edge model than the sprites lane's chroma unmix
 * (`services/sprites/chromaKey.js`): that lane reverses source-over compositing
 * against a known pure-channel key; this one only needs "background gone, 1px
 * anti-spill feather" for an arbitrary measured background color. The shared
 * border/median primitives live in `server/lib/borderKey.js`; this module retains
 * only the image-to-3D flood fill and its conservative sanity gates.
 *
 * Algorithm (deliberately conservative — "not sure" means "don't touch it"):
 *  1. Sample the border pixels; take the per-channel median as the candidate
 *     background color. If less than `KEY_MIN_BORDER_COVERAGE` of the border sits
 *     within `KEY_TOLERANCE` of it, the background isn't solid → pass through.
 *  2. Flood-fill from every matching border pixel (4-neighborhood) → alpha 0.
 *  3. Key enclosed pockets (background color trapped between limbs, unreachable
 *     from the border) with the tighter `KEY_TIGHT_TOLERANCE`, so a subject that
 *     merely contains a similar color isn't punched full of holes.
 *  4. Feather: foreground pixels adjacent to keyed ones get partial alpha scaled
 *     by their color distance to the background — a 1px anti-spill edge, not a
 *     full matte.
 *  5. Sanity-gate the result: if almost nothing or almost everything got keyed,
 *     the detection was wrong → pass through untouched.
 */

import { stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import {
  detectSolidBorderColor as detectSolidBorderColorShared,
  hasMeaningfulAlpha as hasMeaningfulAlphaShared,
} from '../../lib/borderKey.js';
import { atomicWrite, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { decodeRgbaFrame, encodePng } from '../../lib/imageRgba.js';

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

/** Sources above this pixel count skip Node-side keying entirely: the raw
 * decode plus the flood/queue/output buffers scale at ~20 bytes per pixel
 * (a 96 MP gallery image would hold >1 GB and stall the event loop), while
 * TRELLIS.2 downscales its input to 1024px anyway — the pipeline's own
 * matting handles oversized sources. */
export const KEY_MAX_PIXELS = 16_000_000;

// Bump the leading version when the kernel changes. The numeric inputs are
// included so changing a tolerance invalidates fresh keyed output without
// relying on a developer to remember a second, separate cache edit.
export const KEYING_CACHE_VERSION = [
  'source-keying-v1',
  KEY_TOLERANCE,
  KEY_TIGHT_TOLERANCE,
  KEY_MIN_BORDER_COVERAGE,
  KEY_SOFT_BAND,
  KEY_MIN_KEYED_RATIO,
  KEY_MAX_KEYED_RATIO,
  KEY_MAX_PIXELS,
].join(':');

// Squared-distance comparisons throughout the hot loops — Math.sqrt only where a
// real distance is needed (the feather ramp, edge pixels only).
const KEY_TOLERANCE_SQ = KEY_TOLERANCE ** 2;
const KEY_TIGHT_TOLERANCE_SQ = KEY_TIGHT_TOLERANCE ** 2;

const distSq = (data, i, [r, g, b]) => (
  (data[i] - r) ** 2 + (data[i + 1] - g) ** 2 + (data[i + 2] - b) ** 2
);

/** Whether an RGBA buffer already carries a meaningful (non-opaque) alpha channel. */
export const hasMeaningfulAlpha = hasMeaningfulAlphaShared;

/**
 * Detect a solid border color in a raw RGBA buffer. Returns `[r, g, b]` when at
 * least `KEY_MIN_BORDER_COVERAGE` of the border pixels sit within `KEY_TOLERANCE`
 * of the border's median color, else null.
 * @param {{data: Buffer|Uint8Array, width: number, height: number}} image
 * @returns {[number, number, number]|null}
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
 * detection failed its own sanity gates). See the module doc for the algorithm.
 * @param {{data: Buffer|Uint8Array, width: number, height: number}} image
 * @returns {{data: Uint8Array, background: [number, number, number], keyedRatio: number}|null}
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
  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }

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
  // The flood already counted itself (queueLength); count pockets as they key.
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
        // Max(0): an enclosed pixel inside KEY_TOLERANCE (but above the tight
        // pocket threshold) lands here with a negative ramp value.
        out[p * 4 + 3] = Math.max(0, Math.round(((d - KEY_TOLERANCE) / KEY_SOFT_BAND) * 255));
      }
    }
  }
  return { data: out, background, keyedRatio };
}

const runKeySolidBackground = (frame) => {
  const source = frame.data instanceof Uint8Array ? frame.data : Uint8Array.from(frame.data);
  // Always copy the exact view into a fresh ArrayBuffer. Native image decoders
  // and test runners may expose pooled/shared backing stores that Node refuses
  // to transfer, while this copy keeps the worker contract deterministic.
  const transferable = new Uint8Array(source.byteLength);
  transferable.set(source);

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sourceKeyingWorker.js', import.meta.url), {
      workerData: {
        data: transferable.buffer,
        width: frame.width,
        height: frame.height,
      },
      transferList: [transferable.buffer],
    });
    let settled = false;
    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    worker.on('message', (message) => {
      if (message?.type === 'complete') settle(resolve, message.result);
      if (message?.type === 'error') {
        settle(reject, new Error(message.error || 'Background keying worker failed'));
      }
    });
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => {
      if (code !== 0) settle(reject, new Error(`Background keying worker exited with code ${code}`));
    });
  });
};

const keyedCacheMetadataPath = (targetPath) => `${targetPath}.meta.json`;

const hasFreshKeyedSource = async (sourcePath, targetPath) => {
  const sourceStats = await stat(sourcePath);
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats?.isFile() || targetStats.mtimeMs <= sourceStats.mtimeMs) return false;

  const metadata = await readJSONFile(keyedCacheMetadataPath(targetPath), null, { logError: false });
  if (metadata?.version !== KEYING_CACHE_VERSION || !metadata.sourceSha256) return false;
  return metadata.sourceSha256 === await sha256File(sourcePath);
};

/**
 * Resolve whether a render should consume a keyed copy of its source. Reads
 * `sourcePath`; when it has no meaningful alpha and sits on a solid background,
 * writes a keyed PNG to `targetPath` and returns that path. Returns null in
 * every non-keyable case (real alpha already present — the pipeline uses it
 * directly — or no solid background, or the sanity gates tripped): the caller
 * renders the original.
 *
 * I/O failures (unreadable file) reject; the caller treats keying as
 * best-effort (a keying failure must never fail a render the model could still
 * attempt on the raw image).
 *
 * @param {{sourcePath: string, targetPath: string}} opts
 * @returns {Promise<string|null>} the keyed image path, or null to use the original
 */
export async function prepareSourceImage({ sourcePath, targetPath }) {
  if (await hasFreshKeyedSource(sourcePath, targetPath)) return targetPath;

  // Header-only probe: bail before the full decode when the source is too
  // large to key affordably (KEY_MAX_PIXELS), and when it has no alpha channel
  // at all, skip the full-buffer meaningful-alpha scan below (ensureAlpha
  // fabricates the channel).
  const { hasAlpha, width, height } = await sharp(sourcePath).metadata();
  if (!width || !height || width * height > KEY_MAX_PIXELS) return null;
  const frame = await decodeRgbaFrame(sourcePath);
  if (hasAlpha && hasMeaningfulAlpha(frame.data)) return null;
  const result = await runKeySolidBackground(frame);
  if (!result) return null;
  await atomicWrite(targetPath, await encodePng({
    data: result.data,
    width: frame.width,
    height: frame.height,
  }));
  await atomicWrite(keyedCacheMetadataPath(targetPath), {
    version: KEYING_CACHE_VERSION,
    sourceSha256: await sha256File(sourcePath),
  }).catch(() => {});
  return targetPath;
}

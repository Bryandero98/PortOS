/**
 * Small sharp-backed RGBA helpers shared by image-processing lanes.
 *
 * Pixel algorithms belong in sharp-free modules; this file is the deliberate
 * boundary for decoding encoded images and producing PNG bytes.
 */

import sharp from 'sharp';

/** Decode an image to a raw RGBA frame `{ data, width, height }`. */
export async function decodeRgbaFrame(src) {
  const { data, info } = await sharp(src)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Encode a raw frame as PNG bytes without choosing a destination. */
export async function encodePng({ data, width, height }, channels = 4) {
  return sharp(data, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

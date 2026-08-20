/**
 * Sharp-free border and alpha primitives shared by image-processing lanes.
 *
 * Border sampling deliberately uses a narrow band and a subsampled perimeter:
 * one dirty edge row should not overturn an otherwise flat background, while a
 * large source should not allocate one sample for every border pixel.
 */

/** statistics.median: middle value, or mean of the two middles. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const borderBandOffsets = ({ width, height }) => {
  const minDim = Math.min(width, height);
  const band = Math.max(4, Math.floor(minDim / 120));
  const step = Math.max(1, Math.floor(minDim / 320));
  const offsets = [];
  const push = (x, y) => offsets.push((y * width + x) * 4);

  for (let x = 0; x < width; x += step) {
    for (let o = 0; o < band && o < height; o += 1) {
      push(x, o);
      push(x, height - 1 - o);
    }
  }
  for (let y = 0; y < height; y += step) {
    for (let o = 0; o < band && o < width; o += 1) {
      push(o, y);
      push(width - 1 - o, y);
    }
  }
  return offsets;
};

const borderColor = (data, offsets) => (
  [0, 1, 2].map((channel) => median(offsets.map((offset) => data[offset + channel])))
);

const rgbDistanceSq = (data, offset, [r, g, b]) => (
  (data[offset] - r) ** 2
  + (data[offset + 1] - g) ** 2
  + (data[offset + 2] - b) ** 2
);

/**
 * Sample the median RGB value across the subsampled border band.
 *
 * The returned medians intentionally retain the statistics semantics for an
 * even sample count. Callers that need a codec/pipeline-specific integer
 * rounding policy should apply it at their domain boundary.
 *
 * @param {{data: Buffer|Uint8Array, width: number, height: number}} frame
 * @returns {[number, number, number]}
 */
export function sampleBorderKey({ data, width, height }) {
  const offsets = borderBandOffsets({ width, height });
  return borderColor(data, offsets);
}

/**
 * Detect a flat border background using the shared band sampler.
 *
 * @param {{data: Buffer|Uint8Array, width: number, height: number}} frame
 * @param {{tolerance?: number, minCoverage?: number}} options
 * @returns {[number, number, number]|null}
 */
export function detectSolidBorderColor(
  { data, width, height },
  { tolerance = 30, minCoverage = 0.9 } = {},
) {
  const offsets = borderBandOffsets({ width, height });
  if (!offsets.length) return null;
  const color = borderColor(data, offsets);
  const toleranceSq = tolerance ** 2;
  const matching = offsets.reduce(
    (count, offset) => count + (rgbDistanceSq(data, offset, color) <= toleranceSq ? 1 : 0),
    0,
  );
  return matching / offsets.length >= minCoverage ? color : null;
}

/**
 * Whether an RGBA buffer contains alpha below the caller's meaningfulness
 * threshold. The default preserves image-to-3D's historical 250 cutoff; the
 * sprite lane passes 255 to preserve its previous "any alpha variation" test.
 */
export function hasMeaningfulAlpha(data, alphaThreshold = 250) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < alphaThreshold) return true;
  }
  return false;
}

/** Whether an RGBA buffer's alpha channel varies between pixels. */
export function hasAlphaVariation(data) {
  if (data.length < 4) return false;
  const first = data[3];
  for (let i = 7; i < data.length; i += 4) {
    if (data[i] !== first) return true;
  }
  return false;
}

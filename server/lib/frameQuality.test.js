import { describe, it, expect, vi } from 'vitest';
import {
  gradientVariance, meanLuma, scoreFrame, pickBestFrame, decodeGreyscaleFrame,
  RECENCY_WEIGHT, USABLE_QUALITY_FLOOR,
} from './frameQuality.js';

// Deterministic synthetic frames — a real clip's tail can't be checked into
// the repo, and the scorer only ever sees a raw single-channel buffer anyway.
const makeFrame = (width, height, fn) => ({
  width,
  height,
  data: Uint8Array.from({ length: width * height }, (_, i) => fn(i % width, Math.floor(i / width))),
});

// Seeded LCG so "noise" is byte-identical on every run and in CI.
const seededNoise = (width, height, seed = 1) => {
  let s = seed;
  return makeFrame(width, height, () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return Math.floor((s / 0x7fffffff) * 256);
  });
};

// Box-blur the same pattern: identical exposure, strictly less high-frequency
// detail — which is exactly the motion-blur case the anchor picker exists for.
const boxBlur = (frame, radius = 2) => makeFrame(frame.width, frame.height, (x, y) => {
  let total = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < frame.width && ny >= 0 && ny < frame.height) {
        total += frame.data[ny * frame.width + nx];
        count++;
      }
    }
  }
  return Math.round(total / count);
});

const SHARP = seededNoise(48, 48);
const BLURRED = boxBlur(SHARP);
const BLACK = makeFrame(48, 48, () => 0);
const WHITE = makeFrame(48, 48, () => 255);
const FLAT_GREY = makeFrame(48, 48, () => 128);

describe('gradientVariance', () => {
  it('ranks a sharp frame above its blurred twin', () => {
    expect(gradientVariance(SHARP)).toBeGreaterThan(gradientVariance(BLURRED));
  });

  it('is zero for a flat frame and for degenerate input', () => {
    expect(gradientVariance(FLAT_GREY)).toBe(0);
    expect(gradientVariance(null)).toBe(0);
    // Buffer shorter than width*height — a truncated decode, not a frame.
    expect(gradientVariance({ width: 8, height: 8, data: new Uint8Array(4) })).toBe(0);
  });
});

describe('meanLuma', () => {
  it('normalizes to 0..1', () => {
    expect(meanLuma(BLACK)).toBe(0);
    expect(meanLuma(WHITE)).toBe(1);
    expect(meanLuma(FLAT_GREY)).toBeCloseTo(128 / 255, 5);
  });
});

describe('scoreFrame', () => {
  it('scores a sharp frame well above a blurred one at equal recency', () => {
    const sharp = scoreFrame(SHARP, { recency: 0 });
    const blurred = scoreFrame(BLURRED, { recency: 0 });
    expect(sharp.focus).toBeGreaterThan(blurred.focus);
    expect(sharp.score).toBeGreaterThan(blurred.score);
    // The sharp/blur gap must exceed the whole recency budget, or a blurred
    // frame at the cut would outrank a clean one earlier in the window.
    expect(sharp.score - blurred.score).toBeGreaterThan(RECENCY_WEIGHT);
    expect(sharp.usable).toBe(true);
  });

  it('rejects a fade-to-black frame even with the full recency bonus', () => {
    const black = scoreFrame(BLACK, { recency: 1 });
    expect(black.exposurePenalty).toBe(1);
    expect(black.quality).toBeLessThan(USABLE_QUALITY_FLOOR);
    expect(black.usable).toBe(false);
  });

  it('rejects a blown highlight the same way it rejects black', () => {
    expect(scoreFrame(WHITE, { recency: 1 }).usable).toBe(false);
  });

  it('rejects a well-exposed but featureless frame', () => {
    // Perfect exposure alone must not qualify — a flat grey carries nothing
    // for the next chunk to condition on.
    const flat = scoreFrame(FLAT_GREY, { recency: 1 });
    expect(flat.exposurePenalty).toBeLessThan(0.01);
    expect(flat.usable).toBe(false);
  });

  it('breaks a tie between identical frames in favour of the later one', () => {
    const early = scoreFrame(SHARP, { recency: 0 });
    const late = scoreFrame(SHARP, { recency: 1 });
    expect(late.score).toBeGreaterThan(early.score);
    expect(late.score - early.score).toBeCloseTo(RECENCY_WEIGHT, 10);
  });

  it('clamps an out-of-range or non-finite recency instead of skewing the score', () => {
    expect(scoreFrame(SHARP, { recency: 5 }).recency).toBe(1);
    expect(scoreFrame(SHARP, { recency: -1 }).recency).toBe(0);
    expect(scoreFrame(SHARP, { recency: NaN }).recency).toBe(0);
  });
});

// ─── candidate selection ─────────────────────────────────────────────────────

// Minimal sharp stand-in: maps a path to a canned raw greyscale decode, or
// throws for paths meant to model a partial/absent file.
const fakeSharp = (byPath) => (path) => ({
  greyscale() { return this; },
  raw() { return this; },
  async toBuffer() {
    const frame = byPath[path];
    if (!frame) throw new Error(`ENOENT: ${path}`);
    return { data: Buffer.from(frame.data), info: { width: frame.width, height: frame.height } };
  },
});

describe('decodeGreyscaleFrame', () => {
  it('returns null on a decode failure rather than throwing', async () => {
    const sharpImpl = fakeSharp({});
    await expect(decodeGreyscaleFrame('/tmp/missing.png', { sharpImpl })).resolves.toBeNull();
  });
});

describe('pickBestFrame', () => {
  it('picks the sharpest candidate, not the last one', async () => {
    const paths = ['/t/a.png', '/t/b.png', '/t/c.png'];
    const sharpImpl = fakeSharp({ '/t/a.png': BLURRED, '/t/b.png': SHARP, '/t/c.png': BLURRED });
    const best = await pickBestFrame(paths, { sharpImpl });
    expect(best).toMatchObject({ path: '/t/b.png', index: 1 });
  });

  it('prefers the later of two comparably clean candidates', async () => {
    const paths = ['/t/a.png', '/t/b.png'];
    const sharpImpl = fakeSharp({ '/t/a.png': SHARP, '/t/b.png': SHARP });
    const best = await pickBestFrame(paths, { sharpImpl });
    expect(best.index).toBe(1);
    expect(best.recency).toBe(1);
  });

  it('returns null when every candidate is unusable', async () => {
    const paths = ['/t/a.png', '/t/b.png'];
    const sharpImpl = fakeSharp({ '/t/a.png': BLACK, '/t/b.png': BLACK });
    await expect(pickBestFrame(paths, { sharpImpl })).resolves.toBeNull();
  });

  it('returns null when nothing decodes, and never throws', async () => {
    const sharpImpl = fakeSharp({});
    await expect(pickBestFrame(['/t/a.png'], { sharpImpl })).resolves.toBeNull();
    await expect(pickBestFrame([], { sharpImpl })).resolves.toBeNull();
    await expect(pickBestFrame(null, { sharpImpl })).resolves.toBeNull();
  });

  it('skips undecodable candidates but still picks from the rest', async () => {
    const paths = ['/t/a.png', '/t/gone.png', '/t/c.png'];
    const sharpImpl = fakeSharp({ '/t/a.png': SHARP, '/t/c.png': BLURRED });
    const best = await pickBestFrame(paths, { sharpImpl });
    expect(best.path).toBe('/t/a.png');
  });

  it('treats a lone candidate as the newest frame', async () => {
    const sharpImpl = fakeSharp({ '/t/only.png': SHARP });
    const best = await pickBestFrame(['/t/only.png'], { sharpImpl });
    expect(best).toMatchObject({ index: 0, recency: 1 });
  });

  it('does not call sharp for non-string entries', async () => {
    const impl = vi.fn(fakeSharp({ '/t/a.png': SHARP }));
    await pickBestFrame(['/t/a.png', null, '', undefined], { sharpImpl: impl });
    expect(impl).toHaveBeenCalledTimes(1);
  });
});

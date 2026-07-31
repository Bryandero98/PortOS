import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// The registry this module consults, pinned to an install that never authored an
// `idle-loop` track — the default state of every install, since #3152 made every
// non-walk track user-defined. Reading the real table would make the assertion
// below depend on whichever tracks THIS machine happens to have authored.
//
// `effectiveTrack` is mocked ALONGSIDE the table, not just the table: it is the
// call the guard protects (getTrackState resolves the id through it), and
// spreading `importOriginal()` would otherwise hand back the real function
// closed over the real module-scope registry — so on a machine that HAS authored
// `idle-loop` the un-guarded path would resolve, fall through to the
// not-yet-approved branch, and throw the SAME status+code, leaving the test
// green with the guard deleted. That is the exact machine-dependence this
// suite's sibling fixes exist to remove.
const NO_IDLE_LOOP = { walk: { id: 'walk' } };
vi.mock('./animationTrackStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getEffectiveAnimationTracks: () => NO_IDLE_LOOP,
  effectiveTrack: (id) => {
    if (!NO_IDLE_LOOP[id]) {
      throw new Error(`Unknown animation track '${id}' — known tracks: ${Object.keys(NO_IDLE_LOOP).join(', ')}.`);
    }
    return NO_IDLE_LOOP[id];
  },
}));

import {
  buildPresentationIdle,
  buildPresentationIdleLayout,
  composePresentationIdleStrip,
  PRESENTATION_IDLE_CELL_SIZE,
  PRESENTATION_IDLE_LAYOUT_KIND,
  presentationIdleSidecarPath,
} from './presentationIdle.js';

const chromaFrame = async (offset) => {
  const width = 32;
  const height = 24;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = ((y * width) + x) * 3;
      const subject = x >= 8 + offset && x < 18 + offset && y >= 4 && y < 22;
      pixels[index] = subject ? 20 : 255;
      pixels[index + 1] = subject ? 90 : 0;
      pixels[index + 2] = subject ? 110 : 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
};

describe('presentation idle strip', () => {
  it('preserves approved frame order in transparent presentation-size cells', async () => {
    const strip = await composePresentationIdleStrip(
      await Promise.all([chromaFrame(0), chromaFrame(2), chromaFrame(4)]),
      '#FF00FF',
    );
    const metadata = await sharp(strip).metadata();
    expect(metadata).toMatchObject({
      width: PRESENTATION_IDLE_CELL_SIZE * 3,
      height: PRESENTATION_IDLE_CELL_SIZE,
      channels: 4,
    });
    const raw = await sharp(strip).ensureAlpha().raw().toBuffer();
    expect(raw[3]).toBe(0);
    expect(raw[((256 * metadata.width + 256) * 4) + 3]).toBeGreaterThan(0);
  });

  it('describes the strip with a deterministic consumer sidecar', () => {
    const path = 'assets/presentation/hero-idle.png';
    const layout = buildPresentationIdleLayout({
      sha256: 'a'.repeat(64),
      frameCount: 6,
      frameRate: 6,
      cellSize: 512,
      sourceManifestPath: 'idle-loop/approved.json',
      sourceManifestSha256: 'b'.repeat(64),
      sourceFrameSha256s: ['c'.repeat(64)],
    }, path);
    expect(presentationIdleSidecarPath(path)).toBe('assets/presentation/hero-idle.presentation.json');
    expect(layout).toMatchObject({
      kind: PRESENTATION_IDLE_LAYOUT_KIND,
      imageFile: 'hero-idle.png',
      frameCount: 6,
      frameRate: 6,
      cellSize: 512,
    });
  });

  it('answers a missing idle-loop track as a prerequisite, not an internal registry error', async () => {
    // The publish form offers the picker-idle path unconditionally, so an
    // install that never created the track reaches here. Resolving the id
    // through the registry throws a bare Error naming the known tracks — a 500
    // about internals. It must arrive as the same 422 the not-yet-approved case
    // gets, so the UI can tell the user what to create.
    // The MESSAGE is asserted, not just status+code: the not-yet-approved branch
    // below the guard throws an identical 422/PRESENTATION_IDLE_TRACK_REQUIRED,
    // so status+code alone cannot tell "the track does not exist" from "it exists
    // but isn't approved" — and would pass with the guard removed.
    await expect(buildPresentationIdle('rec-1')).rejects.toMatchObject({
      status: 422,
      code: 'PRESENTATION_IDLE_TRACK_REQUIRED',
      message: expect.stringContaining("Create an animation track named 'idle-loop'"),
    });
  });
});

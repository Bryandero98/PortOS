import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
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
});

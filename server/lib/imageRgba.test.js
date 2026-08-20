import { describe, expect, it } from 'vitest';
import { decodeRgbaFrame, encodePng } from './imageRgba.js';

describe('imageRgba', () => {
  it('round-trips a raw RGBA frame through PNG bytes', async () => {
    const frame = {
      data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 128]),
      width: 2,
      height: 1,
    };
    const encoded = await encodePng(frame);
    const decoded = await decodeRgbaFrame(encoded);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    expect([...decoded.data]).toEqual([...frame.data]);
  });
});

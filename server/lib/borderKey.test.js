import { describe, expect, it } from 'vitest';
import {
  detectSolidBorderColor,
  hasMeaningfulAlpha,
  median,
  sampleBorderKey,
} from './borderKey.js';

const makeFrame = (width, height, paint) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height };
};

const GREEN = [30, 200, 40];

describe('borderKey', () => {
  it('uses statistics median semantics for even samples', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('keeps a solid border measurement through one dirty edge row', () => {
    const frame = makeFrame(20, 20, (x, y) => {
      if (y === 0) return [255, 0, 0];
      if (x >= 5 && x < 15 && y >= 5 && y < 15) return [140, 90, 50];
      return GREEN;
    });
    expect(sampleBorderKey(frame)).toEqual(GREEN);
    expect(detectSolidBorderColor(frame)).toEqual(GREEN);
  });

  it('shares the alpha meaningfulness threshold with an explicit override', () => {
    const almostOpaque = makeFrame(2, 1, (x) => [0, 0, 0, x ? 255 : 249]);
    expect(hasMeaningfulAlpha(almostOpaque.data)).toBe(true);
    expect(hasMeaningfulAlpha(almostOpaque.data, 255)).toBe(true);
    expect(hasMeaningfulAlpha(makeFrame(2, 1, () => [0, 0, 0, 255]).data)).toBe(false);
  });
});

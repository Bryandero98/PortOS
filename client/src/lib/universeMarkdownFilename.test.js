import { describe, expect, it } from 'vitest';
import { slugifyUniverseName, universeMarkdownFilename } from './universeMarkdownFilename.js';

describe('universeMarkdownFilename', () => {
  it('matches the server-safe filename contract', () => {
    expect(slugifyUniverseName('The Bright World / V2!')).toBe('the-bright-world-v2');
    expect(slugifyUniverseName('Café')).toBe('cafe');
    expect(universeMarkdownFilename('The Bright World')).toBe('the-bright-world.md');
    expect(universeMarkdownFilename('!!!')).toBe('universe.md');
  });
});

import { describe, expect, it } from 'vitest';
import { slugifyUniverseName, universeMarkdownFilename, universeToMarkdown } from './universeMarkdown.js';

describe('universeToMarkdown', () => {
  it('serializes the full world-bible shape in stored order', () => {
    const markdown = universeToMarkdown({
      name: 'The Bright World',
      logline: 'A world beneath two suns.',
      premise: 'Every map changes when the second sun rises.',
      styleNotes: 'Painted edges and warm copper light.',
      characters: [{ name: 'Mira', role: 'Cartographer', physicalDescription: 'Patient and precise.' }],
      places: [{ name: 'The Archive', description: 'A tower of living maps.' }],
      objects: [{ name: 'Sun Compass', description: 'Points toward the next dawn.' }],
      categories: {
        ziggurats: { kind: 'places', variations: [{ label: 'Old Ziggurat', prompt: 'terraced stone' }] },
        landscapes: { kind: 'places', variations: [{ label: 'Copper Flats', prompt: 'shimmering salt' }] },
      },
      influences: { embrace: ['copper', 'dust'], avoid: ['plastic'] },
      compositeSheets: [{ label: 'Costume Board', imageRefs: ['costume-board.png'], prompt: 'not exported' }],
      styleReferences: [{ title: 'Ink Wash', imageRefs: ['ink-wash.png'], prompt: 'not exported' }],
    });

    expect(markdown).toContain('# The Bright World');
    expect(markdown).toContain('A world beneath two suns.\n\nEvery map changes when the second sun rises.');
    expect(markdown).toContain('## Characters\n\n### Mira');
    expect(markdown).toContain('**Physical Description:** Patient and precise.');
    expect(markdown).toContain('## Places\n\n### The Archive');
    expect(markdown).toContain('## Objects\n\n### Sun Compass');
    expect(markdown).toContain('## Categories\n\n### landscapes');
    expect(markdown).toContain('### ziggurats');
    expect(markdown.indexOf('### landscapes')).toBeLessThan(markdown.indexOf('### ziggurats'));
    expect(markdown).toContain('- Embrace: copper');
    expect(markdown).toContain('- Avoid: plastic');
    expect(markdown).toContain('## Composite Sheets\n\n- Costume Board — costume-board.png');
    expect(markdown).toContain('## Style References\n\n- Ink Wash — ink-wash.png');
    expect(markdown).not.toContain('not exported');
  });

  it('omits empty canon sections and auxiliary sections', () => {
    const markdown = universeToMarkdown({
      name: 'Empty World',
      characters: [],
      places: [],
      objects: [],
      categories: {},
      influences: { embrace: [], avoid: [] },
      compositeSheets: [],
      styleReferences: [],
    });

    expect(markdown).toBe('# Empty World\n');
    expect(markdown).not.toContain('## Characters');
    expect(markdown).not.toContain('## Categories');
    expect(markdown).not.toContain('## Influences');
  });

  it('tolerates missing optional fields and malformed list values', () => {
    expect(universeToMarkdown({ name: 'Minimal World' })).toBe('# Minimal World\n');
    expect(universeToMarkdown(null)).toBe('# Untitled Universe\n');
    expect(universeToMarkdown({ name: 'Safe', characters: [null, { name: 'One' }] }))
      .toContain('### One');
  });
});

describe('universe markdown filenames', () => {
  it('slugifies names safely and falls back when no slug remains', () => {
    expect(slugifyUniverseName('The Bright World / V2!')).toBe('the-bright-world-v2');
    expect(slugifyUniverseName('Café')).toBe('cafe');
    expect(slugifyUniverseName('!!!')).toBe('universe');
    expect(universeMarkdownFilename('The Bright World')).toBe('the-bright-world.md');
  });
});

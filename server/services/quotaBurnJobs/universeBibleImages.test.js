import { describe, expect, it } from 'vitest';
import { buildRenderSelection, countPending, findMissingImageEntries, inFlightKey, resolveRenderMode } from './universeBibleImages.js';

const universe = {
  id: 'u1',
  name: 'Example Universe',
  categories: {
    landscapes: {
      variations: [
        { id: 'v1', label: 'Salt Flats', imageRefs: [] },
        { id: 'v2', label: 'Rendered Ridge', imageRefs: ['ridge.png'] },
      ],
    },
  },
  compositeSheets: [{ id: 's1', label: 'Cast Sheet' }],
  characters: [
    { id: 'c1', name: 'Alice', imageRefs: [] },
    { id: 'c2', name: 'Bob', imageRefs: ['bob.png'] },
  ],
  places: [{ id: 'p1', slugline: 'EXT. FOUNDRY — DAY' }],
  objects: [],
};

describe('findMissingImageEntries', () => {
  it('returns only entries whose imageRefs are empty', () => {
    const rows = findMissingImageEntries(universe);
    expect(rows.map((row) => row.label)).toEqual(['Salt Flats', 'Cast Sheet', 'Alice', 'EXT. FOUNDRY — DAY']);
  });

  it('falls back to a place\'s slugline, matching what compilePrompts selects on', () => {
    // A canon place may carry ONLY a slugline. Keying on `name` alone would make
    // those entries permanently unselectable — they would show as pending
    // forever and never render.
    const rows = findMissingImageEntries(universe, { scope: 'canon' });
    expect(rows.some((row) => row.label === 'EXT. FOUNDRY — DAY')).toBe(true);
  });

  it('honors a narrowed scope', () => {
    expect(findMissingImageEntries(universe, { scope: 'variations' }).map((r) => r.label)).toEqual(['Salt Flats']);
    expect(findMissingImageEntries(universe, { scope: 'sheets' }).map((r) => r.label)).toEqual(['Cast Sheet']);
  });

  it('tolerates an empty or malformed universe', () => {
    expect(findMissingImageEntries(null)).toEqual([]);
    expect(findMissingImageEntries({})).toEqual([]);
  });

  it('holds back undescribed canon when requireDescribed is on', () => {
    // Alice is a bare name; rendering her spends image quota on a generic
    // figure. The variation and the composite sheet are unaffected — their
    // sanitizer requires a prompt, so they cannot be undescribed.
    const rows = findMissingImageEntries(universe, { requireDescribed: true });
    expect(rows.map((row) => row.label)).toEqual(['Salt Flats', 'Cast Sheet']);
  });

  it('lets a canon entry through once it has a core description', () => {
    const described = {
      ...universe,
      characters: [{
        id: 'c1',
        name: 'Alice',
        imageRefs: [],
        physicalDescription: 'a', personality: 'b', background: 'c', motivations: 'd', visualNotes: 'e',
      }],
      places: [],
    };
    const rows = findMissingImageEntries(described, { scope: 'canon', requireDescribed: true });
    expect(rows.map((row) => row.label)).toEqual(['Alice']);
  });
});

describe('buildRenderSelection', () => {
  it('splits rows back into the three shapes compilePrompts reads', () => {
    expect(buildRenderSelection(findMissingImageEntries(universe))).toEqual({
      selection: { landscapes: ['Salt Flats'] },
      canonSelection: { characters: ['Alice'], places: ['EXT. FOUNDRY — DAY'] },
      sheetSelection: ['Cast Sheet'],
    });
  });
});

describe('resolveRenderMode', () => {
  it('refuses to fall through to the install default for a family with no image backend', () => {
    // `claude` renders no images. Falling through would spend a DIFFERENT
    // provider's image quota while claude's window expires unused — and charge
    // claude's dispatch cap for it, the exact inversion the pin exists to stop.
    expect(resolveRenderMode({ family: { id: 'claude' }, params: {} })).toBeNull();
    expect(resolveRenderMode({ family: { id: 'codex' }, params: {} })).toBe('codex');
    // An explicit pin on the job always wins.
    expect(resolveRenderMode({ family: { id: 'claude' }, params: { mode: 'grok' } })).toBe('grok');
  });
});

describe('countPending', () => {
  it('reports zero (with a fixable reason) when the family has no render backend', async () => {
    await expect(countPending({ params: {}, family: { id: 'claude' } }))
      .resolves.toMatchObject({ count: 0, detail: expect.stringContaining('renders no images') });
  });
});

describe('label deduping', () => {
  it('collapses entries that share a label case-insensitively', () => {
    // compilePrompts matches a selection entry against EVERY variation whose
    // label matches case-insensitively, and nothing dedupes labels on write —
    // so one selected row would enqueue two renders, one of them re-rendering
    // an entry that already has an image, and blow past maxEntries.
    const dupes = {
      id: 'u2',
      categories: { vehicles: { variations: [
        { id: 'a', label: 'Skiff', imageRefs: [] },
        { id: 'b', label: 'skiff', imageRefs: [] },
      ] } },
    };
    const { selection } = buildRenderSelection(findMissingImageEntries(dupes));
    expect(selection.vehicles).toHaveLength(2);
    // The job's own collect() dedupes before selecting — pinned via the export,
    // which takes a ROW (passing bare labels here would compare `undefined` to
    // `undefined` and pass no matter what the key did).
    const row = (label) => ({ kind: 'variation', categoryKey: 'vehicles', label });
    expect(inFlightKey('u2', row('Skiff'))).toBe(inFlightKey('u2', row('skiff')));
    expect(inFlightKey('u2', row('Skiff'))).not.toBe(inFlightKey('u2', row('Barge')));
  });
});

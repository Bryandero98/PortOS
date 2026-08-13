import { describe, expect, it } from 'vitest';

import {
  BIBLE_CORE_FIELDS,
  BIBLE_EXPAND_FIELDS,
  bibleEntryCompleteness,
  bibleEntryIsDescribed,
  bibleFieldIsBlank,
  missingBibleFields,
  normalizeDescribeDepth,
} from './universeBibleCompleteness.js';

const describedCharacter = () => {
  const groups = BIBLE_EXPAND_FIELDS.character;
  const entry = { id: 'c1', name: 'Alice' };
  for (const field of groups.strings) entry[field] = `${field} text`;
  for (const field of groups.lists) entry[field] = [{ name: 'x' }];
  entry.arcType = 'positive';
  entry.sliders = { proactivity: 7, likability: 6, competence: 8 };
  return entry;
};

describe('missingBibleFields', () => {
  it('reports every unfilled character-sheet field at full depth', () => {
    const missing = missingBibleFields('character', { id: 'c1', name: 'Alice' });
    const groups = BIBLE_EXPAND_FIELDS.character;
    expect(missing).toHaveLength(
      groups.strings.length + groups.lists.length + groups.enums.length + groups.objects.length,
    );
    expect(missing).toContain('physicalDescription');
    expect(missing).toContain('colorPalette');
    expect(missing).toContain('sliders');
  });

  it('reports nothing for a fully-sheeted character', () => {
    expect(missingBibleFields('character', describedCharacter())).toEqual([]);
    expect(bibleEntryIsDescribed('character', describedCharacter())).toBe(true);
  });

  it('core depth asks only for what makes an entry renderable', () => {
    const core = {
      id: 'c1',
      name: 'Alice',
      physicalDescription: 'a', personality: 'b', background: 'c', motivations: 'd', visualNotes: 'e',
    };
    expect(missingBibleFields('character', core, { depth: 'core' })).toEqual([]);
    // The same entry is still far from a finished sheet.
    expect(missingBibleFields('character', core, { depth: 'full' }).length).toBeGreaterThan(10);
  });

  it('treats a character with only the legacy `description` alias as described', () => {
    // Migration 019 rewrites `description` → `physicalDescription`, but the
    // read-side fallback stays. Without it a pre-migration entry reads as blank
    // and gets re-described on top of text it already has.
    expect(bibleFieldIsBlank({ description: 'weathered, tall' }, 'physicalDescription')).toBe(false);
    expect(missingBibleFields('place', { description: 'a foundry' }, { depth: 'core' })).toEqual([]);
  });

  it('counts a partly-rated sliders object as unfilled', () => {
    // `sliders` is always present after sanitization with null axes, so plain
    // presence would report it filled the moment the record was written.
    expect(bibleFieldIsBlank({ sliders: { proactivity: 7, likability: null, competence: 3 } }, 'sliders')).toBe(true);
    expect(bibleFieldIsBlank({ sliders: { proactivity: 7, likability: 2, competence: 3 } }, 'sliders')).toBe(false);
  });

  it('never asks for id-bearing link fields an expand call cannot mint', () => {
    const all = Object.values(BIBLE_EXPAND_FIELDS).flatMap((groups) => [
      ...groups.strings, ...groups.lists, ...groups.enums, ...groups.objects,
    ]);
    expect(all).not.toContain('relationshipLinks');
    expect(all).not.toContain('attachments');
  });

  it('reports nothing for an unknown kind or a non-object entry', () => {
    expect(missingBibleFields('sandwich', { name: 'x' })).toEqual([]);
    expect(missingBibleFields('character', null)).toEqual([]);
  });
});

describe('bibleEntryCompleteness', () => {
  it('reports the gap size the describe job orders its picks by', () => {
    const empty = bibleEntryCompleteness('place', { id: 'p1' });
    const partial = bibleEntryCompleteness('place', { id: 'p2', description: 'a foundry', era: 'late-industrial' });
    expect(empty.filled).toBe(0);
    expect(partial.filled).toBe(2);
    expect(partial.missing.length).toBeLessThan(empty.missing.length);
    expect(empty.complete).toBe(false);
  });
});

describe('normalizeDescribeDepth', () => {
  it('defaults an unknown depth to full rather than silently narrowing the ask', () => {
    expect(normalizeDescribeDepth('core')).toBe('core');
    expect(normalizeDescribeDepth('full')).toBe('full');
    expect(normalizeDescribeDepth('deep')).toBe('full');
    expect(normalizeDescribeDepth(undefined)).toBe('full');
  });
});

describe('core sets', () => {
  it('are a subset of what the expand prompts can actually fill', () => {
    for (const [kind, fields] of Object.entries(BIBLE_CORE_FIELDS)) {
      const groups = BIBLE_EXPAND_FIELDS[kind];
      const fillable = new Set([...groups.strings, ...groups.lists, ...groups.enums, ...groups.objects]);
      // A core field the expand prompt cannot fill would make the entry
      // permanently under-described and re-picked on every burn cycle.
      for (const field of fields) expect(fillable.has(field)).toBe(true);
    }
  });
});

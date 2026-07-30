import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

import migration from './209-seed-drum-example-song.js';
import { runBrainSeedMigrationTests } from './_brainSeedTestHelpers.js';
import { parseDrumChart } from '../../client/src/lib/drumNotation.js';

const SEED_ID = 'song-seed-example-rock-beat';

describe('migration 209 — seed the drum example song', () => {
  // The shared brain-seed contract (split-install write, never-overwrite,
  // tombstone-safe, idempotent, legacy top-up, unreadable-data safety).
  runBrainSeedMigrationTests({
    migration,
    number: 209,
    entityType: 'songs',
    seedId: SEED_ID,
    // Invented fixture (privacy convention) — mirrors the shipped shape.
    record: {
      title: 'Example Rock Beat',
      artist: 'The Placeholders',
      instrument: 'drums',
      content: { format: 'drum', text: 'HH: xxxx\nK: o---' },
      attachments: [],
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      originInstanceId: 'seed',
    },
    otherId: 'song-seed-other',
  });

  it('ships a parseable drum chart in the real reference file', () => {
    const shipped = JSON.parse(readFileSync(new URL('../../data.reference/brain/songs.json', import.meta.url), 'utf-8'));
    const rec = shipped.records[SEED_ID];
    expect(rec).toBeDefined();
    expect(rec.title).toBe('Example Rock Beat');
    expect(rec.artist).toBe('The Placeholders');
    expect(rec.instrument).toBe('drums');
    expect(rec.content.format).toBe('drum');
    expect(rec.attachments).toEqual([]);
    // A fixed originInstanceId keeps the record byte-identical on every install,
    // so the brain reconcile checksum converges (see migration 190's note).
    expect(rec.originInstanceId).toBe('seed');
    // The worked example must actually parse clean — a seed with errors would
    // teach the format wrong.
    const chart = parseDrumChart(rec.content.text);
    expect(chart.errors).toEqual([]);
    expect(chart.bars.length).toBeGreaterThan(1);
    expect(chart.pieces).toContain('K');
    expect(chart.pieces).toContain('S');
    expect(chart.pieces).toContain('HH');
    expect(chart.tempo).toBeGreaterThan(0);
    // …and it must exercise the repeat + glyph range it's demonstrating.
    expect(chart.bars.some((b) => b.repeat > 1)).toBe(true);
    const glyphs = new Set(chart.bars.flatMap((b) => b.rows.flatMap((r) => r.cells.map((c) => c.id))));
    for (const id of ['normal', 'accent', 'open', 'ghost', 'rest']) expect(glyphs).toContain(id);
  });
});

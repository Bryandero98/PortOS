import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

import migration from './213-seed-hotrs-drums-song.js';
import { runBrainSeedMigrationTests } from './_brainSeedTestHelpers.js';
import { parseDrumChart } from '../../client/src/lib/drumNotation.js';

const SEED_ID = 'song-seed-hotrs-drums';

describe('migration 213 — seed the House of the Rising Sun drum part', () => {
  // The shared brain-seed contract (split-install write, never-overwrite,
  // tombstone-safe, idempotent, legacy top-up, unreadable-data safety).
  runBrainSeedMigrationTests({
    migration,
    number: 213,
    entityType: 'songs',
    seedId: SEED_ID,
    // Invented fixture (privacy convention) — mirrors the shipped shape.
    record: {
      title: 'House of the Rising Sun',
      artist: 'Traditional',
      instrument: 'drums',
      content: { format: 'drum', text: 'time: 6/8\nsubdivision: 1\n\nHH: xxxxxx\nK: o-----' },
      attachments: [],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      originInstanceId: 'seed',
    },
    otherId: 'song-seed-other',
  });

  it('ships a parseable 6/8 drum chart in the real reference file', () => {
    const shipped = JSON.parse(readFileSync(new URL('../../data.reference/brain/songs.json', import.meta.url), 'utf-8'));
    const rec = shipped.records[SEED_ID];
    expect(rec).toBeDefined();
    expect(rec.title).toBe('House of the Rising Sun');
    expect(rec.artist).toBe('Traditional');
    expect(rec.instrument).toBe('drums');
    expect(rec.content.format).toBe('drum');
    expect(rec.attachments).toEqual([]);
    // Same key as the guitar/piano/ukulele arrangements, so the four seeds read
    // as one song across the SongBook index rather than four unrelated entries.
    expect(rec.key).toBe('Am');
    // Seed records MUST ship a fixed originInstanceId — see migration 190's test
    // for why (boot backfill would otherwise hash the same seed differently on
    // every peer and defeat the brain reconcile checksum).
    expect(rec.originInstanceId).toBe('seed');
    // The chart must parse clean — a seed with errors would teach the format wrong.
    const chart = parseDrumChart(rec.content.text);
    expect(chart.errors).toEqual([]);
    // 6/8 with one cell per eighth: the meter is the whole point of this
    // arrangement (the other seeds are the same song's arpeggiated 6/8), and the
    // renderer/playback both read `beatValue` as "the tempo counts eighths".
    expect(chart.time).toEqual({ beats: 6, beatValue: 8 });
    expect(chart.subdivision).toBe(1);
    expect(chart.stepsPerBar).toBe(6);
    // Four times through the 8-bar Am-C-D-F-Am-C-E-E progression.
    expect(chart.bars.length).toBe(32);
    expect(chart.bars.some((b) => b.repeat > 1)).toBe(true);
    for (const piece of ['K', 'S', 'HH', 'RD', 'CR']) expect(chart.pieces).toContain(piece);
    // The written tempo counts EIGHTHS, so it is deliberately high — guard the
    // band the practice-tempo control can actually reach (metronome 20–320, and
    // the transport's 110% button multiplies it).
    expect(chart.tempo).toBeGreaterThanOrEqual(180);
    expect(Math.round(chart.tempo * 1.1)).toBeLessThanOrEqual(320);
  });
});

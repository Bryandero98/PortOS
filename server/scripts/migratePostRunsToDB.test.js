import { describe, expect, it } from 'vitest';
import { groupLegacyTrainingRuns, normalizeLegacyPostSession, normalizeLegacyTrainingEntry } from './migratePostRunsToDB.js';

const NOW = '2026-08-17T12:00:00.000Z';

describe('legacy POST normalization (#4441)', () => {
  it('preserves scored ids/dates/timestamps and derives stable attempt ids', () => {
    const run = normalizeLegacyPostSession({
      id: 'session-1', date: '2026-08-16', startedAt: '2026-08-16T10:00:00.000Z',
      completedAt: '2026-08-16T10:05:00.000Z', modules: ['mental-math'],
      tasks: [{ module: 'mental-math', type: 'multiplication', totalMs: 5000, score: 80 }],
    }, 0, NOW);
    expect(run).toMatchObject({ id: 'session-1', mode: 'test', localDay: '2026-08-16', legacy: true });
    expect(run.attempts[0]).toMatchObject({
      id: 'session-1:attempt:0', inputMode: 'unknown', scorerProvenance: 'legacy', legacy: true,
    });
  });

  it('preserves training ids and marks irreconstructible provenance explicitly', () => {
    const run = normalizeLegacyTrainingEntry({
      id: 'entry-1', date: '2026-08-15', timestamp: '2026-08-15T09:00:00.000Z',
      module: 'memory', mode: 'spaced', correct: 4, total: 5, totalMs: 30000,
    }, 0, NOW);
    expect(run).toMatchObject({
      id: 'legacy-training-run:entry-1', mode: 'training', localDay: '2026-08-15', legacy: true,
    });
    expect(run.attempts[0]).toMatchObject({
      id: 'entry-1', drillType: 'spaced', inputMode: 'unknown', scorerProvenance: 'legacy', legacy: true,
    });
  });

  it('groups newer legacy-file entries that already share a run id', () => {
    const runs = groupLegacyTrainingRuns([
      { id: 'a-1', runId: 'run-1', date: '2026-08-15', timestamp: '2026-08-15T09:00:00.000Z', module: 'mental-math', drillType: 'powers' },
      { id: 'a-2', runId: 'run-1', date: '2026-08-15', timestamp: '2026-08-15T09:01:00.000Z', module: 'cognitive', drillType: 'stroop' },
    ], NOW);
    expect(runs).toHaveLength(1);
    expect(runs[0].attempts.map((attempt) => attempt.id)).toEqual(['a-1', 'a-2']);
    expect(runs[0].planned.modules).toEqual(['mental-math', 'cognitive']);
  });
});

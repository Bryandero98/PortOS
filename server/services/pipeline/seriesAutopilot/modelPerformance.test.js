import { describe, expect, it, vi } from 'vitest';

const { patchRunMetadata } = vi.hoisted(() => ({ patchRunMetadata: vi.fn() }));

vi.mock('../../runner.js', () => ({
  getRun: vi.fn(async () => ({ id: 'run-1' })),
  listRuns: vi.fn(),
  patchRunMetadata,
}));

import { MIN_QUALITY_SAMPLES, recordModelOutcome, summarizeModelPerformance } from './modelPerformance.js';

const provider = (id, models, enabled = true) => ({ id, name: id, models, enabled });
const run = (over = {}) => ({
  autopilotSystem: 'series',
  pipelineStage: 'foundationGate',
  pipelineRole: 'creative',
  providerId: 'cloud',
  providerName: 'Cloud',
  model: 'large',
  effort: 'high',
  success: true,
  duration: 1_000,
  startTime: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('Series Autopilot model performance', () => {
  it('backfills effort onto historical run evidence', async () => {
    await recordModelOutcome('run-1', {
      role: 'creative', stage: 'foundationGate', outcome: 'rejected', effort: 'max',
    });
    expect(patchRunMetadata).toHaveBeenCalledWith('run-1', expect.objectContaining({ effort: 'max' }));
  });

  it('keeps technical completion separate from quality rejection', () => {
    const { metrics } = summarizeModelPerformance([
      run({ qualityOutcome: 'rejected', qualityScoreDelta: -0.2 }),
      run({ success: false, errorCategory: 'timeout' }),
    ], [provider('cloud', ['large'])]);
    expect(metrics[0]).toMatchObject({
      attempts: 2,
      technicalSuccesses: 1,
      technicalFailures: 1,
      qualityAccepted: 0,
      qualityRejected: 1,
      qualityEvaluated: 1,
      meanScoreDelta: -0.2,
    });
  });

  it('does not mistake a parse-valid judge response for editorial approval', () => {
    const { metrics, recommendations } = summarizeModelPerformance([
      run({ pipelineRole: 'judge', qualityOutcome: 'valid' }),
      run({ pipelineRole: 'judge', qualityOutcome: 'valid' }),
    ], [provider('cloud', ['large'])]);
    expect(metrics[0]).toMatchObject({ contractValid: 2, qualityEvaluated: 0 });
    expect(recommendations).toEqual({});
  });

  it('requires multiple reviewed samples before recommending a route', () => {
    expect(MIN_QUALITY_SAMPLES).toBe(2);
    const one = summarizeModelPerformance([
      run({ qualityOutcome: 'accepted' }),
    ], [provider('cloud', ['large'])]);
    expect(one.recommendations).toEqual({});

    const enough = summarizeModelPerformance([
      run({ qualityOutcome: 'accepted' }),
      run({ qualityOutcome: 'accepted', startTime: '2026-01-02T00:00:00.000Z' }),
    ], [provider('cloud', ['large'])]);
    expect(enough.recommendations.foundationGate.creative).toMatchObject({
      providerOverride: 'cloud', modelOverride: 'large', effortOverride: 'high', samples: 2,
    });
  });

  it('ranks accepted local evidence above repeatedly rejected cloud work', () => {
    const runs = [
      run({ qualityOutcome: 'rejected' }),
      run({ qualityOutcome: 'rejected' }),
      run({ providerId: 'ollama', providerName: 'Ollama', model: 'local-14b', effort: null, qualityOutcome: 'accepted' }),
      run({ providerId: 'ollama', providerName: 'Ollama', model: 'local-14b', effort: null, qualityOutcome: 'accepted' }),
    ];
    const { recommendations } = summarizeModelPerformance(runs, [
      provider('cloud', ['large']),
      provider('ollama', ['local-14b']),
    ]);
    expect(recommendations.foundationGate.creative).toMatchObject({
      providerOverride: 'ollama', modelOverride: 'local-14b', accepted: 2, rejected: 0,
    });
  });

  it('never recommends a disabled provider or a removed model', () => {
    const runs = [run({ qualityOutcome: 'accepted' }), run({ qualityOutcome: 'accepted' })];
    expect(summarizeModelPerformance(runs, [provider('cloud', ['large'], false)]).recommendations).toEqual({});
    expect(summarizeModelPerformance(runs, [provider('cloud', ['other'])]).recommendations).toEqual({});
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The sweep's only two collaborators: the report (what to measure) and the
// single-model runner (measure it). Both are mocked so the queue's own behavior
// — order, cancellation, failure isolation — is what's under test.
vi.mock('./localModelAssessments.js', () => ({
  getAssessmentReport: vi.fn(),
  runAssessment: vi.fn(),
}));

import { getAssessmentReport, runAssessment } from './localModelAssessments.js';
import { startSweep, getSweepStatus, cancelSweep, __resetSweep } from './localModelAssessmentSweep.js';

// Let the detached loop run to completion. The sweep deliberately does NOT
// return a promise for its own queue (the HTTP handler must return immediately),
// so a test has to drain the microtask queue instead.
const settle = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };

const report = ({ unassessed = [], assessments = [], uninstalled = [] } = {}) => ({
  unassessed, assessments, uninstalled,
});

const measured = (verdict = 'fits', meanTokensPerSecond = 42) => ({
  verdict, performance: { meanTokensPerSecond, meanCharsPerSecond: 170 },
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetSweep();
});
afterEach(() => __resetSweep());

describe('startSweep', () => {
  it('measures every unmeasured model in order and records what each produced', async () => {
    getAssessmentReport.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'a' }, { backend: 'ollama', modelId: 'b' }],
    }));
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ scope: 'unmeasured' });
    expect(started.status).toBe('running');
    expect(started.total).toBe(2);

    await settle();
    const status = getSweepStatus();
    expect(status.status).toBe('complete');
    expect(status.results.map((r) => r.modelId)).toEqual(['a', 'b']);
    expect(status.results[0].meanTokensPerSecond).toBe(42);
    // Sequential by design — two models at once would measure the contention.
    expect(runAssessment).toHaveBeenCalledTimes(2);
  });

  it('passes each target\'s recorded tuning through, so a re-measure reproduces it', async () => {
    getAssessmentReport.mockResolvedValue(report({
      assessments: [{
        backend: 'llama', modelId: 'tuned', tuningKey: 'ctx=8192', tuningLabel: '8k',
        tuning: { contextSize: 8192 }, staleness: { stale: true },
      }],
    }));
    runAssessment.mockResolvedValue(measured());

    await startSweep({ scope: 'stale' });
    await settle();
    expect(runAssessment).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'llama', modelId: 'tuned', tuning: { contextSize: 8192 },
    }));
  });

  // The point of an overnight run is that it gets through the list. One model
  // that throws must not abandon the rest of the queue.
  it('records a failed model as a result and keeps going', async () => {
    getAssessmentReport.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'broken' }, { backend: 'ollama', modelId: 'fine' }],
    }));
    runAssessment
      .mockRejectedValueOnce(new Error('backend refused the model'))
      .mockResolvedValueOnce(measured());

    await startSweep({ scope: 'unmeasured' });
    await settle();
    const status = getSweepStatus();
    expect(status.status).toBe('complete');
    expect(status.results[0]).toMatchObject({ modelId: 'broken', error: 'backend refused the model', verdict: null });
    expect(status.results[1]).toMatchObject({ modelId: 'fine', verdict: 'fits' });
  });

  it('never queues a model that is no longer installed', async () => {
    getAssessmentReport.mockResolvedValue(report({
      assessments: [
        { backend: 'ollama', modelId: 'gone', tuningKey: '', tuning: {}, staleness: { stale: true } },
        { backend: 'ollama', modelId: 'here', tuningKey: '', tuning: {}, staleness: { stale: true } },
      ],
      uninstalled: [{ backend: 'ollama', modelId: 'gone' }],
    }));
    runAssessment.mockResolvedValue(measured());

    const started = await startSweep({ scope: 'stale' });
    expect(started.total).toBe(1);
    await settle();
    expect(runAssessment).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'here' }));
  });

  // A refused start has to SAY so — a silent no-op would leave the page waiting
  // for progress that never arrives.
  it('refuses a second sweep while one is running', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    // Never resolves: the first sweep stays in flight for the duration.
    runAssessment.mockImplementation(() => new Promise(() => {}));

    await startSweep({ scope: 'unmeasured' });
    const second = await startSweep({ scope: 'unmeasured' });
    expect(second.rejected).toBe('a sweep is already running');
  });

  it('refuses a scope that covers nothing', async () => {
    getAssessmentReport.mockResolvedValue(report());
    const result = await startSweep({ scope: 'all' });
    expect(result.rejected).toBe('nothing to measure for that scope');
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('emits start and per-model progress frames under the sweep scope', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());
    const frames = [];

    await startSweep({ scope: 'unmeasured', onProgress: (f) => frames.push(f) });
    await settle();
    expect(frames.map((f) => f.event)).toEqual(['start', 'model-start', 'complete']);
    expect(frames.every((f) => f.scope === 'assessment-sweep')).toBe(true);
  });

  it('survives a progress listener that throws', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockResolvedValue(measured());

    await startSweep({ scope: 'unmeasured', onProgress: () => { throw new Error('socket closed'); } });
    await settle();
    expect(getSweepStatus().status).toBe('complete');
  });
});

describe('cancelSweep', () => {
  it('stops the queue and keeps what was already measured', async () => {
    getAssessmentReport.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'a' }, { backend: 'ollama', modelId: 'b' }],
    }));
    // First model lands; the second reports itself cancelled, as runAssessment
    // does when it sees the abort signal.
    runAssessment
      .mockResolvedValueOnce(measured())
      .mockResolvedValueOnce({ cancelled: true });

    await startSweep({ scope: 'unmeasured' });
    await Promise.resolve();
    cancelSweep();
    await settle();

    const status = getSweepStatus();
    expect(status.status).toBe('cancelled');
    // The abandoned model is NOT a result — recording it would make a stopped
    // sweep look like it measured what it gave up on.
    expect(status.results.map((r) => r.modelId)).toEqual(['a']);
  });

  it('is a no-op when nothing is running', () => {
    expect(cancelSweep().status).toBe('idle');
  });

  // Cancelling frees the slot immediately, so a replacement sweep can start
  // while the abandoned one is still unwinding its last model. That loop must
  // not write its results (or its terminal frame) into the new queue.
  it('does not let an abandoned queue write into the sweep that replaced it', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'slow' }] }));
    let releaseFirst;
    runAssessment.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));

    await startSweep({ scope: 'unmeasured' });
    cancelSweep();

    // A fresh queue takes over before the abandoned model resolves.
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'second' }] }));
    runAssessment.mockResolvedValue(measured());
    const frames = [];
    await startSweep({ scope: 'unmeasured', onProgress: (f) => frames.push(f) });

    releaseFirst(measured('fits', 9));
    await settle();

    const status = getSweepStatus();
    expect(status.results.map((r) => r.modelId)).toEqual(['second']);
    // Exactly one terminal frame, and it belongs to the queue still standing.
    expect(frames.filter((f) => f.event === 'complete')).toHaveLength(1);
  });
});

describe('getSweepStatus', () => {
  it('reports idle before anything has been started', () => {
    expect(getSweepStatus()).toMatchObject({ status: 'idle', total: 0, completed: 0, current: null, results: [] });
  });

  it('never exposes the abort controller', async () => {
    getAssessmentReport.mockResolvedValue(report({ unassessed: [{ backend: 'ollama', modelId: 'a' }] }));
    runAssessment.mockImplementation(() => new Promise(() => {}));
    await startSweep({ scope: 'unmeasured' });
    expect(getSweepStatus().controller).toBeUndefined();
  });
});

import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn(),
  PATHS: { runs: '/example/runs' },
  readJSONFile: vi.fn().mockResolvedValue(null)
}));

vi.mock('./usage.js', () => ({
  applyHistoricalUsageCorrections: vi.fn().mockResolvedValue({
    corrected: 1,
    correctedRunIds: ['run-example-1']
  }),
  getReconciledUsageRunIds: vi.fn().mockReturnValue(['run-live'])
}));

const {
  __resetHistoricalUsageBackfillForTests,
  getHistoricalUsageBackfillStatus,
  startHistoricalUsageBackfill
} = await import('./usageBackfill.js');

class FakeWorker extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  unref() {}
}

beforeEach(() => {
  FakeWorker.instances = [];
  __resetHistoricalUsageBackfillForTests();
});

describe('historical usage backfill job', () => {
  it('runs scanning off-thread and exposes progress through status', async () => {
    const started = startHistoricalUsageBackfill({
      runsDir: '/example/runs',
      home: '/example/home',
      WorkerClass: FakeWorker
    });
    expect(started.status).toBe('running');
    expect(FakeWorker.instances).toHaveLength(1);
    const worker = FakeWorker.instances[0];
    expect(worker.options.workerData).toMatchObject({
      runsDir: '/example/runs',
      home: '/example/home',
      reconciledRunIds: ['run-live']
    });

    worker.emit('message', { type: 'progress', progress: { processed: 2, total: 5, found: 1 } });
    await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus()).toMatchObject({
      status: 'running',
      processed: 2,
      total: 5,
      found: 1
    }));

    worker.emit('message', {
      type: 'complete',
      result: {
        processed: 5,
        total: 5,
        corrections: [{ runId: 'run-example-1', metadataPath: '/example/metadata.json' }]
      }
    });
    await vi.waitFor(() => expect(getHistoricalUsageBackfillStatus()).toMatchObject({
      status: 'complete',
      corrected: 1,
      processed: 5,
      total: 5
    }));
  });
});

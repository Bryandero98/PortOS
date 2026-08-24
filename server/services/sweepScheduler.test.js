import { beforeEach, describe, expect, it, vi } from 'vitest';

const cancelMock = vi.fn();
const getEventMock = vi.fn();
const scheduleMock = vi.fn();

vi.mock('./eventScheduler.js', () => ({
  cancel: (...args) => cancelMock(...args),
  getEvent: (...args) => getEventMock(...args),
  schedule: (...args) => scheduleMock(...args),
}));

const { createSweepScheduler } = await import('./sweepScheduler.js');

beforeEach(() => {
  cancelMock.mockClear();
  getEventMock.mockReset();
  scheduleMock.mockClear();
});

const build = () => createSweepScheduler({
  id: 'demo-gc',
  intervalMs: 60_000,
  initialDelayMs: 5_000,
  handler: vi.fn(),
  source: 'demoGc',
});

describe('createSweepScheduler', () => {
  it('registers a delayed boot sweep and a recurring interval', () => {
    const handler = vi.fn();
    const scheduler = createSweepScheduler({
      id: 'demo-gc',
      intervalMs: 60_000,
      initialDelayMs: 5_000,
      handler,
      source: 'demoGc',
    });

    scheduler.start();

    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock.mock.calls.map(([event]) => event)).toEqual([
      {
        id: 'demo-gc:initial',
        type: 'once',
        delayMs: 5_000,
        handler,
        metadata: { source: 'demoGc' },
      },
      {
        id: 'demo-gc',
        type: 'interval',
        intervalMs: 60_000,
        handler,
        metadata: { source: 'demoGc' },
      },
    ]);
  });

  it('keeps start idempotent while the interval is active', () => {
    getEventMock.mockReturnValue({ active: true });

    build().start();

    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('cancels both the delayed and recurring events', () => {
    build().stop();

    expect(cancelMock.mock.calls).toEqual([
      ['demo-gc:initial'],
      ['demo-gc'],
    ]);
  });
});

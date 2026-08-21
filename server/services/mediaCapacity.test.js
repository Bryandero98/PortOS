import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCudaCapability = vi.fn();
const getQueueCapacity = vi.fn();

vi.mock('../lib/cudaCapability.js', () => ({ getCudaCapability: (...args) => getCudaCapability(...args) }));
vi.mock('./mediaJobQueue/index.js', () => ({ getQueueCapacity: (...args) => getQueueCapacity(...args) }));

const { getMediaCapacity } = await import('./mediaCapacity.js');

const capacity = (overrides = {}) => ({
  lanes: {
    gpu: { running: 0, queued: 0, limit: 1 },
    cloud: { running: 0, queued: 0, limit: 1 },
    remote: { running: 0, queued: 0, limit: 20 },
  },
  byKind: {
    video: { running: 0, queued: 0 },
    image: { running: 0, queued: 0 },
    training: { running: 0, queued: 0 },
    audio: { running: 0, queued: 0 },
  },
  totals: { running: 0, queued: 0 },
  runningKind: null,
  ...overrides,
});

describe('getMediaCapacity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCudaCapability.mockResolvedValue({ status: 'available' });
    getQueueCapacity.mockReturnValue(capacity());
  });

  it('reports the GPU lane busy with the kind it is rendering', async () => {
    getQueueCapacity.mockReturnValue(capacity({
      lanes: {
        gpu: { running: 1, queued: 2, limit: 1 },
        cloud: { running: 0, queued: 0, limit: 1 },
        remote: { running: 0, queued: 0, limit: 20 },
      },
      totals: { running: 1, queued: 2 },
      runningKind: 'video',
    }));
    const result = await getMediaCapacity();
    expect(result.gpu.laneBusy).toBe(true);
    expect(result.gpu.laneKind).toBe('video');
    expect(result.lanes.gpu).toEqual({ running: 1, queued: 2, limit: 1 });
    expect(result.totals).toEqual({ running: 1, queued: 2 });
  });

  it('reports an idle GPU lane as not busy with no kind', async () => {
    const result = await getMediaCapacity();
    expect(result.gpu.laneBusy).toBe(false);
    expect(result.gpu.laneKind).toBeNull();
  });

  // The whole point of the three-state contract: a probe that could not run is
  // not the same claim as "this machine has no CUDA device".
  it.each(['available', 'absent', 'unknown'])('passes through the %s CUDA state verbatim', async (status) => {
    getCudaCapability.mockResolvedValue({ status });
    expect((await getMediaCapacity()).gpu.cudaStatus).toBe(status);
  });

  it('degrades a failed CUDA probe to unknown rather than absent', async () => {
    getCudaCapability.mockRejectedValue(new Error('nvidia-smi exploded'));
    const result = await getMediaCapacity();
    expect(result.gpu.cudaStatus).toBe('unknown');
    // The rest of the report still has to arrive — a GPU probe failure must not
    // blank out queue depth the queue itself knows perfectly well.
    expect(result.lanes.remote.limit).toBe(20);
  });

  it('carries per-kind queue depth through', async () => {
    getQueueCapacity.mockReturnValue(capacity({
      byKind: {
        video: { running: 0, queued: 0 },
        image: { running: 1, queued: 3 },
        training: { running: 0, queued: 0 },
        audio: { running: 0, queued: 1 },
      },
    }));
    const result = await getMediaCapacity();
    expect(result.byKind.image).toEqual({ running: 1, queued: 3 });
    expect(result.byKind.audio).toEqual({ running: 0, queued: 1 });
  });
});

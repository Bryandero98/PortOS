import { beforeEach, describe, expect, it, vi } from 'vitest';
import { negotiateVideoConstraints, prepareRemoteMediaJob } from './remoteSubmission.js';

const mockGetPeers = vi.fn();
const mockResolveFederatedMediaProvider = vi.fn();

vi.mock('../instances.js', () => ({
  getPeers: (...args) => mockGetPeers(...args),
}));

vi.mock('../federatedMediaConsumer.js', () => ({
  resolveFederatedMediaProvider: (...args) => mockResolveFederatedMediaProvider(...args),
}));

beforeEach(() => {
  mockGetPeers.mockReset();
  mockResolveFederatedMediaProvider.mockReset();
});

describe('negotiateVideoConstraints', () => {
  it('snaps numFrames down to the nearest n*stride + 1', () => {
    const capability = {
      modelId: 'wan22_t2v_a14b',
      frameStride: 8,
    };

    expect(negotiateVideoConstraints({ numFrames: 33 }, capability).numFrames).toBe(33);
    expect(negotiateVideoConstraints({ numFrames: 40 }, capability).numFrames).toBe(33);
    expect(negotiateVideoConstraints({ numFrames: 41 }, capability).numFrames).toBe(41);
  });

  it('clamps numFrames to maxNumFrames respecting stride', () => {
    const capability = {
      modelId: 'wan22_t2v_a14b',
      frameStride: 4,
      maxNumFrames: 33,
    };

    expect(negotiateVideoConstraints({ numFrames: 40 }, capability).numFrames).toBe(33);
  });

  it('leaves numFrames untouched when capability has null or absent frameStride and maxNumFrames', () => {
    expect(negotiateVideoConstraints({ numFrames: 40 }, { frameStride: null, maxNumFrames: null }).numFrames).toBe(40);
    expect(negotiateVideoConstraints({ numFrames: 40 }, { frameStride: null }).numFrames).toBe(40);
    expect(negotiateVideoConstraints({ numFrames: 40 }, {}).numFrames).toBe(40);
  });

  it('snaps numFrames to the nearest discrete option when frameOptions is present', () => {
    const capability = {
      modelId: 'minimax_h3',
      frameOptions: [107, 124, 141, 158],
    };

    expect(negotiateVideoConstraints({ numFrames: 50 }, capability).numFrames).toBe(107);
    expect(negotiateVideoConstraints({ numFrames: 121 }, capability).numFrames).toBe(124);
    expect(negotiateVideoConstraints({ numFrames: 124 }, capability).numFrames).toBe(124);
    expect(negotiateVideoConstraints({ numFrames: 130 }, capability).numFrames).toBe(124);
    expect(negotiateVideoConstraints({ numFrames: 200 }, capability).numFrames).toBe(158);
  });

  it('snaps fps to the nearest option when fpsOptions is present', () => {
    const capability = {
      modelId: 'minimax_h3',
      fpsOptions: [24, 25],
    };

    expect(negotiateVideoConstraints({ fps: 16 }, capability).fps).toBe(24);
    expect(negotiateVideoConstraints({ fps: 30 }, capability).fps).toBe(25);
  });

  it('floors frameStride at stride + 1 rather than emitting 1-frame video', () => {
    const capability = {
      modelId: 'wan22_t2v_a14b',
      frameStride: 4,
    };

    expect(negotiateVideoConstraints({ numFrames: 3 }, capability).numFrames).toBe(5);
  });

  it('rejects when requested numFrames is invalid (< 1)', () => {
    const capability = {
      modelId: 'wan22',
      frameStride: 8,
    };

    expect(() => negotiateVideoConstraints({ numFrames: -5 }, capability))
      .toThrow(/invalid/);
  });
});

describe('prepareRemoteMediaJob', () => {
  it('negotiates video constraints and attaches the negotiated request to remoteMedia', async () => {
    mockGetPeers.mockResolvedValue([{ id: 'peer-1', name: 'Render Box' }]);
    mockResolveFederatedMediaProvider.mockResolvedValue({
      capability: {
        kind: 'video',
        engine: 'local',
        modelId: 'wan22_t2v_a14b',
        ready: true,
        frameStride: 8,
      },
    });

    const result = await prepareRemoteMediaJob({
      peerId: 'peer-1',
      kind: 'video',
      request: {
        kind: 'video',
        engine: 'local',
        modelId: 'wan22_t2v_a14b',
        prompt: 'a scenic drive',
        numFrames: 40,
      },
    });

    expect(result.request.numFrames).toBe(33);
    expect(result.remoteMedia.request.numFrames).toBe(33);
  });
});

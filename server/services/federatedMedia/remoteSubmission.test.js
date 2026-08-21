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

  it('leaves numFrames untouched when capability has no frameStride or maxNumFrames', () => {
    const capability = { modelId: 'ltx2' };
    expect(negotiateVideoConstraints({ numFrames: 40 }, capability).numFrames).toBe(40);
  });

  it('snaps width and height to closest aspect ratio when resolutionOptions is present', () => {
    const capability = {
      modelId: 'minimax_h3',
      resolutionOptions: [
        { label: '16:9', w: 1344, h: 768 },
        { label: '9:16', w: 768, h: 1344 },
      ],
    };

    const snapped = negotiateVideoConstraints({ width: 1280, height: 720 }, capability);
    expect(snapped.width).toBe(1344);
    expect(snapped.height).toBe(768);
  });

  it('rejects when frame count cannot be made legal', () => {
    const capability = {
      modelId: 'wan22',
      frameStride: 8,
      maxNumFrames: 0,
    };

    expect(() => negotiateVideoConstraints({ numFrames: 25 }, capability))
      .toThrow(/cannot be satisfied/);
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

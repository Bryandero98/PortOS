import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ healthy: true, platformSupported: true, cuda: 'available', cached: true }));
vi.mock('./pipeline/musicGen.js', () => ({
  DEFAULT_ENGINE_ID: 'musicgen',
  ENGINES: {
    musicgen: {
      id: 'musicgen', name: 'MusicGen', models: [{ id: 'default-model', name: 'Default', repo: 'example/default' }],
      defaultModelId: 'default-model', minDurationSec: 5, maxDurationSec: 60, defaultDurationSec: 30,
      customModels: true, fixedModelInstall: false, cudaRequired: false,
      installEnv: 'INSTALL_MUSICGEN', venvDefault: '/example/venv',
    },
  },
  getEngineModel: () => null,
  isEngineHealthy: async () => state.healthy,
  isEnginePlatformSupported: () => state.platformSupported,
  enginePlatformLabel: () => 'supported platform',
}));
vi.mock('./audioModels.js', () => ({
  listEngineModels: async () => [{ id: 'default-model', name: 'Default', repo: 'example/default', userAdded: false }],
}));
vi.mock('../lib/hfCache.js', () => ({ inspectModelCache: async () => ({ cached: state.cached }) }));
vi.mock('../lib/cudaCapability.js', () => ({ getCudaCapability: async () => ({ status: state.cuda }) }));

const { listMusicEngineCatalog, resolveMusicEngineSelection } = await import('./musicEngineCatalog.js');

beforeEach(() => {
  state.healthy = true;
  state.platformSupported = true;
  state.cuda = 'available';
  state.cached = true;
});

describe('musicEngineCatalog', () => {
  it('returns the live catalog used by both the UI and commissions', async () => {
    await expect(listMusicEngineCatalog()).resolves.toMatchObject({
      defaultEngine: 'musicgen',
      engines: [{ id: 'musicgen', ready: true, defaultModelId: 'default-model' }],
    });
  });

  it('resolves omitted values to the installed defaults', async () => {
    await expect(resolveMusicEngineSelection()).resolves.toEqual({
      status: 'ready',
      selection: { engine: 'musicgen', modelId: 'default-model', repo: 'example/default' },
    });
  });

  it('fails closed for a removed model or unavailable runtime', async () => {
    await expect(resolveMusicEngineSelection({ modelId: 'removed' })).resolves.toEqual({
      status: 'unavailable', reason: 'music-model-unavailable',
    });
    state.healthy = false;
    await expect(resolveMusicEngineSelection()).resolves.toEqual({
      status: 'unavailable', reason: 'music-engine-unavailable',
    });
  });

  it('fails closed on an unsupported platform even if a stale runtime looks healthy', async () => {
    state.platformSupported = false;
    await expect(resolveMusicEngineSelection()).resolves.toEqual({
      status: 'unavailable', reason: 'music-engine-unavailable',
    });
  });
});

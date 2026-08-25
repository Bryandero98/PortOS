import { describe, expect, it, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({ settings: {}, corrupt: false, updateSettingsWith: vi.fn() }));

vi.mock('./settings.js', () => ({
  getSettingsWithStatus: vi.fn(async () => ({ corrupt: mock.corrupt, settings: structuredClone(mock.settings) })),
  updateSettingsWith: mock.updateSettingsWith,
}));

import {
  getInstanceFeatures,
  isInstanceFeatureEnabled,
  resolveInstanceFeatures,
  updateInstanceFeature,
} from './instanceFeatures.js';

describe('instance features', () => {
  beforeEach(() => {
    mock.settings = {};
    mock.corrupt = false;
    mock.updateSettingsWith.mockReset();
    mock.updateSettingsWith.mockImplementation(async (mutate) => {
      mock.settings = await mutate(structuredClone(mock.settings));
      return structuredClone(mock.settings);
    });
  });

  it('keeps POST enabled by default for existing installs', async () => {
    expect(await isInstanceFeatureEnabled('post')).toBe(true);
    expect((await getInstanceFeatures()).features[0]).toMatchObject({ id: 'post', enabled: true });
  });

  it('resolves an explicit disable without changing POST configuration', () => {
    expect(resolveInstanceFeatures({ instanceFeatures: { post: { enabled: false } } })[0]).toMatchObject({
      id: 'post',
      enabled: false,
    });
  });

  it('fails closed for malformed persisted feature flags', async () => {
    const settings = { instanceFeatures: { post: { enabled: 'false' } } };

    expect(resolveInstanceFeatures(settings)[0]).toMatchObject({ id: 'post', enabled: false });
    mock.settings = settings;
    expect(await isInstanceFeatureEnabled('post')).toBe(false);
  });

  it('fails closed when settings cannot be read or parsed', async () => {
    mock.corrupt = true;

    expect(resolveInstanceFeatures({}, { corrupt: true })[0]).toMatchObject({ id: 'post', enabled: false });
    expect(await isInstanceFeatureEnabled('post')).toBe(false);
    expect((await getInstanceFeatures()).features[0]).toMatchObject({ id: 'post', enabled: false });
  });

  it('updates one feature inside the instance-local settings slice', async () => {
    mock.settings = { theme: 'dark', instanceFeatures: { post: { enabled: true, future: 'keep' } } };

    const result = await updateInstanceFeature('post', false);

    expect(mock.settings).toEqual({
      theme: 'dark',
      instanceFeatures: { post: { enabled: false, future: 'keep' } },
    });
    expect(result.features[0]).toMatchObject({ id: 'post', enabled: false });
    expect(await isInstanceFeatureEnabled('post')).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getSettings = vi.fn();
vi.mock('../services/api', () => ({
  getSettings: (...args) => getSettings(...args),
}));

import useImageRenderSettings from './useImageRenderSettings.js';
import { PIPELINE_IMAGE_DEFAULTS } from '../lib/pipelineImageDefaults.js';

beforeEach(() => {
  getSettings.mockReset();
});

describe('useImageRenderSettings', () => {
  it('starts at the pipeline defaults before settings resolve', () => {
    getSettings.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useImageRenderSettings());
    expect(result.current.imageCfg).toEqual(PIPELINE_IMAGE_DEFAULTS);
  });

  it('reads the stored pipeline image config and fetches silently', async () => {
    getSettings.mockResolvedValue({ pipeline: { imageGen: { modelId: 'custom-model', width: 768 } } });
    const { result } = renderHook(() => useImageRenderSettings());
    await waitFor(() => expect(result.current.imageCfg.modelId).toBe('custom-model'));
    expect(result.current.imageCfg.width).toBe(768);
    expect(getSettings).toHaveBeenCalledWith({ silent: true });
  });

  it('fails open to the defaults when the settings fetch rejects', async () => {
    getSettings.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useImageRenderSettings());
    // No throw; cfg stays at the defaults.
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(result.current.imageCfg).toEqual(PIPELINE_IMAGE_DEFAULTS);
  });

  // Wiring only — the ladder's own matrix is covered by `renderPinLadder`'s
  // unit tests. Codex + agy both enabled means `readPipelineImageSettings`
  // picks codex, so an agy result can only have come from a pin.
  describe('render pin ladder', () => {
    const CLOUD_ON = { codex: { enabled: true }, agy: { enabled: true } };

    it('resolves the record pin, then the target pin, then the install default', async () => {
      getSettings.mockResolvedValue({ imageGen: CLOUD_ON });
      const { result, rerender } = renderHook(
        (props) => useImageRenderSettings(props),
        { initialProps: { record: { imageMode: 'agy' }, target: 'universe-bible' } },
      );
      await waitFor(() => expect(result.current.imageCfg.mode).toBe('agy'));

      getSettings.mockResolvedValue({
        imageGen: CLOUD_ON, renderDefaults: { 'universe-bible': { imageMode: 'agy' } },
      });
      const target = renderHook(() => useImageRenderSettings({ record: {}, target: 'universe-bible' }));
      await waitFor(() => expect(target.result.current.imageCfg.mode).toBe('agy'));

      rerender({ record: {}, target: 'universe-bible' });
      expect(result.current.imageCfg.mode).toBe('codex');
    });

    it('fails open to the bare defaults when the settings fetch fails', async () => {
      // No settings blob means no install default and no backend list to gate a
      // pin against, so the ladder is skipped entirely rather than applied over
      // a guessed cfg — the pre-ladder fail-open behavior, unchanged.
      getSettings.mockRejectedValue(new Error('offline'));
      const { result } = renderHook(() => useImageRenderSettings({ record: { imageMode: 'agy' } }));
      await waitFor(() => expect(getSettings).toHaveBeenCalled());
      expect(result.current.imageCfg).toEqual(PIPELINE_IMAGE_DEFAULTS);
    });
  });
});

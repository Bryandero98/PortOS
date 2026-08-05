import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import useTaskModelPins from './useTaskModelPins';

// Mirrors the shipped `agy models` catalog: the effort tiers are separate ids,
// and not every model has all three (`claude-sonnet-4-6` has none at all).
const AGY = {
  id: 'antigravity-cli',
  name: 'Antigravity CLI',
  type: 'cli',
  command: 'agy',
  enabled: true,
  defaultModel: 'antigravity-configured-default',
  models: [
    'antigravity-configured-default',
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    'claude-sonnet-4-6',
  ],
};

const mount = (config, onUpdate = vi.fn().mockResolvedValue(true)) => {
  const hook = renderHook(() => useTaskModelPins({
    taskType: 'code-review',
    config,
    providers: [AGY],
    activeProviderId: AGY.id,
    onUpdate,
  }));
  return { ...hook, onUpdate };
};

describe('useTaskModelPins — Antigravity base models + effort', () => {
  it('lists base models, not the per-tier ids, since the surface picks effort separately', () => {
    const { result } = mount({ providerId: AGY.id });
    expect(result.current.availableModels).toEqual([
      'gemini-3.6-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6',
    ]);
  });

  it('keeps a stored pre-split id selectable so it still shows what the task runs', () => {
    const { result } = mount({ providerId: AGY.id, model: 'gemini-3.6-flash-high' });
    expect(result.current.availableModels).toContain('gemini-3.6-flash-high');
  });

  it('clears the effort in the same write when the new model has no tiers at all', async () => {
    // `claude-sonnet-4-6` hides the effort select entirely, so a leftover `high`
    // would keep being sent with no UI left to drop it — agy rejects the pair.
    const { result, onUpdate } = mount({ providerId: AGY.id, model: 'gemini-3.6-flash', effort: 'high' });
    await act(async () => { await result.current.changeModel('claude-sonnet-4-6'); });
    expect(onUpdate).toHaveBeenCalledWith('code-review', { model: 'claude-sonnet-4-6', effort: null });
  });

  it('leaves the effort alone when the new model merely narrows the ladder', async () => {
    // `gemini-3.1-pro` offers low/high only; EffortSelect renders the clamp as a
    // visible option rather than silently discarding the user's choice.
    const { result, onUpdate } = mount({ providerId: AGY.id, model: 'gemini-3.6-flash', effort: 'medium' });
    await act(async () => { await result.current.changeModel('gemini-3.1-pro'); });
    expect(onUpdate).toHaveBeenCalledWith('code-review', { model: 'gemini-3.1-pro' });
  });
});

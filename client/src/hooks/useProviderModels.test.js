import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({ getProviders: vi.fn() }));

import * as api from '../services/api';
import useProviderModels from './useProviderModels';

// The catalog `agy models` prints — the shipped provider list mirrors it, and
// its defaultModel is the "use the CLI's own model" sentinel.
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
    'claude-sonnet-4-6', 'gpt-oss-120b-medium',
  ],
};

const CODEX = {
  id: 'codex',
  name: 'Codex',
  type: 'cli',
  command: 'codex',
  enabled: true,
  defaultModel: 'gpt-5',
  models: ['gpt-5', 'gpt-5-high'],
};

// `withEffort` is what opts a picker into base models — it declares that the
// caller also renders an effort control, so the tiers aren't lost.
const mountWith = async (providers, options = { withEffort: true }) => {
  api.getProviders.mockResolvedValue({ providers });
  const hook = renderHook(() => useProviderModels(options));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
};

describe('useProviderModels — Antigravity base models', () => {
  beforeEach(() => vi.clearAllMocks());

  it('collapses the effort-suffixed catalog into base models', async () => {
    const { result } = await mountWith([AGY]);
    expect(result.current.availableModels).toEqual([
      'gemini-3.6-flash',
      'gemini-3.1-pro',
      'claude-sonnet-4-6',
      'gpt-oss-120b',
    ]);
  });

  it('does not re-surface the configured-default sentinel as the auto-selected pin', async () => {
    const { result } = await mountWith([AGY]);
    // The sentinel is the provider's defaultModel, so it IS the selected value —
    // but filterSelectableModels exists to keep it out of the options.
    expect(result.current.selectedModel).toBe('antigravity-configured-default');
    expect(result.current.availableModels).not.toContain('antigravity-configured-default');
  });

  it('keeps a legacy effort-suffixed pin visible instead of blanking the select', async () => {
    const { result } = await mountWith([AGY]);
    act(() => result.current.setSelectedModel('gemini-3.6-flash-high'));
    await waitFor(() => {
      expect(result.current.availableModels).toContain('gemini-3.6-flash-high');
    });
    // The base list is still there — the stale pin is appended, not substituted.
    expect(result.current.availableModels).toContain('gemini-3.6-flash');
  });

  it('leaves other providers\' model lists untouched', async () => {
    const { result } = await mountWith([CODEX]);
    // `gpt-5-high` is NOT an Antigravity id, so its `-high` is not a tier suffix.
    expect(result.current.availableModels).toEqual(['gpt-5', 'gpt-5-high']);
  });

  it('keeps the per-tier ids for a picker with no effort control (the default)', async () => {
    // Without an effort select, the suffixed ids are the ONLY way to pick a
    // tier — collapsing them there would strip the capability, not relocate it.
    const { result } = await mountWith([AGY], {});
    expect(result.current.availableModels).toEqual([
      'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
      'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
      'claude-sonnet-4-6', 'gpt-oss-120b-medium',
    ]);
  });
});

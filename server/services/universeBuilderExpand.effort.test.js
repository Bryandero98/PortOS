import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveProviderAndModelMock, runPromptThroughProviderMock } = vi.hoisted(() => ({
  resolveProviderAndModelMock: vi.fn(),
  runPromptThroughProviderMock: vi.fn(),
}));

vi.mock('../lib/promptRunner.js', () => ({
  assertProvider: vi.fn(),
  resolveProviderAndModel: (...args) => resolveProviderAndModelMock(...args),
  runPromptThroughProvider: (...args) => runPromptThroughProviderMock(...args),
}));

const { expandWorldTemplate } = await import('./universeBuilderExpand.js');

const provider = { id: 'codex-tui', name: 'Codex TUI', type: 'tui' };

beforeEach(() => {
  resolveProviderAndModelMock.mockReset();
  runPromptThroughProviderMock.mockReset();
  resolveProviderAndModelMock.mockResolvedValue({ provider, selectedModel: 'gpt-5.6-sol' });
  runPromptThroughProviderMock.mockResolvedValue({
    text: JSON.stringify({
      logline: 'A repaired world.',
      premise: 'Costs and limits now drive the conflict.',
      styleNotes: 'Specific and tactile.',
      influences: { embrace: [], avoid: [] },
      categories: {},
      compositeSheets: [],
      characters: [],
      places: [],
      objects: [],
    }),
    runId: 'run-world-repair',
  });
});

describe('expandWorldTemplate reasoning effort', () => {
  it('forwards a caller effort override to the provider runner', async () => {
    await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
    });

    expect(runPromptThroughProviderMock).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      source: 'universe-builder-expansion',
    }));
  });
});

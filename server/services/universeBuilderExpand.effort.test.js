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

  it('uses a narrative-only contract for foundation world repairs', async () => {
    await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      foundationDirective: 'Define the relay hops and their metabolic cost.',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      narrativeOnly: true,
    });

    const call = runPromptThroughProviderMock.mock.calls[0][0];
    expect(call).toMatchObject({
      effort: 'ultra',
      source: 'universe-builder-narrative-repair',
    });
    expect(call.prompt).toContain('exact costs');
    expect(call.prompt).toContain('Define the relay hops and their metabolic cost.');
    expect(call.prompt).toContain('Do not emit influences, categories, compositeSheets, characters, places, objects');
    expect(call.prompt).not.toContain('Generate 5-12 categories');
    expect(call.prompt).not.toContain('world_pitch_poster');
  });

  it('retries an oversized narrative repair before persistence can clip it mid-sentence', async () => {
    runPromptThroughProviderMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'x'.repeat(4_001),
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-oversized',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'Trade, authority, and travel now end in a complete rule.',
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-bounded',
      });

    const result = await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      foundationDirective: 'Define ordinary governance.',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      narrativeOnly: true,
    });

    expect(runPromptThroughProviderMock).toHaveBeenCalledTimes(2);
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('premise exceeds 4000 characters (got 4001)');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('Do not cut a sentence');
    expect(result.premise).toBe('Trade, authority, and travel now end in a complete rule.');
    expect(result.llm).toMatchObject({ provider: 'codex-tui', model: 'gpt-5.6-sol' });
  });
});

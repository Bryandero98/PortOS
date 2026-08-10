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

  it('compresses the actual oversized narrative draft before persistence can clip it', async () => {
    runPromptThroughProviderMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'x'.repeat(20_001),
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
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('premise exceeds 20000 characters (got 20001)');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain(`"premise": "${'x'.repeat(200)}`);
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('premise: at most 18000 characters');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('Do not cut off a sentence');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).not.toContain('# Starter idea');
    expect(result.premise).toBe('Trade, authority, and travel now end in a complete rule.');
    expect(result.llm).toMatchObject({ provider: 'codex-tui', model: 'gpt-5.6-sol' });
  });

  it('tightens headroom while carrying the latest rejected draft into a final compression pass', async () => {
    runPromptThroughProviderMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'a'.repeat(21_000),
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-oversized',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'b'.repeat(20_200),
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-still-oversized',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'A complete, compact operating rule.',
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

    expect(runPromptThroughProviderMock).toHaveBeenCalledTimes(3);
    expect(runPromptThroughProviderMock.mock.calls[2][0].prompt).toContain(`"premise": "${'b'.repeat(200)}`);
    expect(runPromptThroughProviderMock.mock.calls[2][0].prompt).toContain('premise: at most 16000 characters');
    expect(runPromptThroughProviderMock.mock.calls[2][0].prompt).not.toContain(`"premise": "${'a'.repeat(200)}`);
    expect(result.premise).toBe('A complete, compact operating rule.');
  });

  it('retries the source task when there is no complete draft to compress', async () => {
    runPromptThroughProviderMock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          premise: 'A world without its required pitch.',
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-missing-field',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          logline: 'A repaired world.',
          premise: 'A complete operating rule.',
          styleNotes: 'Specific and tactile.',
        }),
        runId: 'run-complete',
      });

    await expandWorldTemplate({
      starterPrompt: 'Example Universe',
      foundationDirective: 'Define ordinary governance.',
      providerId: 'codex-tui',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      narrativeOnly: true,
    });

    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('# Starter idea');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('logline is missing');
    expect(runPromptThroughProviderMock.mock.calls[1][0].prompt).toContain('Return a complete replacement');
  });
});

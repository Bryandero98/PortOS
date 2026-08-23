import { describe, it, expect, vi, beforeEach } from 'vitest';

// The toolkit singleton is the only thing buildPrompt reaches out to. Stubbing
// it keeps this a pure test of the render pipeline (partial expansion →
// variable substitution → creative IP-latitude stamp).
const stages = new Map();
const templates = new Map();

vi.mock('../lib/aiToolkitState.js', () => ({
  setAIToolkitInstance: vi.fn(),
  requireToolkit: () => ({
    services: {
      prompts: {
        getStage: (name) => stages.get(name) || null,
        getStageTemplate: async (name) => templates.get(name) || null,
        getVariables: () => ({}),
      },
    },
  }),
}));

const { buildPrompt } = await import('./promptService.js');
const { CREATIVE_LATITUDE_HEADING } = await import('../lib/creativeLatitude.js');

const defineStage = (name, template) => {
  stages.set(name, { name, variables: [] });
  templates.set(name, template);
};

beforeEach(() => {
  stages.clear();
  templates.clear();
});

describe('buildPrompt — creative IP-latitude clause', () => {
  it('stamps a creative stage so the model does not genericize named IP', async () => {
    defineStage('pipeline-prose', 'Write chapter {{n}}.');
    const out = await buildPrompt('pipeline-prose', { n: 3 });
    expect(out).toContain(CREATIVE_LATITUDE_HEADING);
    expect(out).toContain('Write chapter 3.');
    // Prepended: the stage's own output contract keeps the last word.
    expect(out.startsWith(CREATIVE_LATITUDE_HEADING)).toBe(true);
    expect(out.trimEnd().endsWith('Write chapter 3.')).toBe(true);
  });

  it('leaves an operational stage unstamped', async () => {
    defineStage('cos-task-enhance', 'Rewrite this task: {{task}}.');
    const out = await buildPrompt('cos-task-enhance', { task: 'ship it' });
    expect(out).toBe('Rewrite this task: ship it.');
  });

  it('throws on an unknown stage rather than rendering an unstamped prompt', async () => {
    await expect(buildPrompt('no-such-stage', {})).rejects.toThrow(/not found/);
  });
});

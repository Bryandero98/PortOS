import { describe, it, expect, vi, beforeEach } from 'vitest';

// `cd_produceVideoFromIssue` mints a SEPARATE CD project, so the calling
// project's render pin (#3135 — what a creative commission stamps its video
// backend onto) has to be handed across that boundary explicitly. Without it a
// commission pinned to Grok would render its teaser on the install default.
vi.mock('../../creativeDirector/bridgeFromIssue.js', () => ({
  produceVideoFromIssue: vi.fn(async () => ({ project: { id: 'cd-2' }, proposal: {} })),
}));
vi.mock('../../creativeDirector/local.js', () => ({ getProject: vi.fn(async () => null) }));

import { produceVideoFromIssue } from '../../creativeDirector/bridgeFromIssue.js';
import { getProject } from '../../creativeDirector/local.js';
import { CD_TOOLS } from './cd.js';

const tool = CD_TOOLS.find((t) => t.name === 'cd_produceVideoFromIssue');
const run = (args, ctx = {}) => tool.execute(args, ctx);
const options = () => produceVideoFromIssue.mock.calls.at(-1)[1];

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue(null);
});

describe('cd_produceVideoFromIssue — render pin inheritance', () => {
  it('passes no pin when the tool runs outside a project context', async () => {
    await run({ issueId: 'iss-1' });
    expect(getProject).not.toHaveBeenCalled();
    expect(options()).toEqual({});
  });

  it("inherits the calling project's video pin and model", async () => {
    getProject.mockResolvedValue({ id: 'cd-1', modelId: 'wan-2.2', renderBackend: { video: { mode: 'grok' } } });
    await run({ issueId: 'iss-1' }, { projectId: 'cd-1' });
    expect(options()).toEqual({ renderBackend: { video: { mode: 'grok' } }, modelId: 'wan-2.2' });
  });

  it('an unpinned calling project contributes nothing (byte-identical to before)', async () => {
    getProject.mockResolvedValue({ id: 'cd-1' });
    await run({ issueId: 'iss-1' }, { projectId: 'cd-1' });
    expect(options()).toEqual({});
  });

  it('an unreadable project degrades to no inherited pin rather than failing the step', async () => {
    getProject.mockRejectedValue(new Error('store down'));
    await run({ issueId: 'iss-1' }, { projectId: 'cd-1' });
    expect(options()).toEqual({});
  });

  it('the LLM-authored args still win over the inherited geometry', async () => {
    getProject.mockResolvedValue({ id: 'cd-1', renderBackend: { video: { mode: 'grok' } } });
    await run({ issueId: 'iss-1', quality: 'high' }, { projectId: 'cd-1' });
    expect(options()).toEqual({ renderBackend: { video: { mode: 'grok' } }, quality: 'high' });
  });

  it('the planner cannot author a backend of its own — the schema drops those keys', async () => {
    // The pin is the USER's configured choice. `execute` spreads the parsed args
    // over the inherited pin, so the only thing keeping the LLM from overriding
    // it is that the schema carries no renderBackend/modelId key at all.
    const parsed = tool.schema.parse({
      issueId: 'iss-1', renderBackend: { video: { mode: 'local' } }, modelId: 'attacker-model',
    });
    expect(parsed).toEqual({ issueId: 'iss-1' });

    getProject.mockResolvedValue({ id: 'cd-1', modelId: 'wan-2.2', renderBackend: { video: { mode: 'grok' } } });
    await run(parsed, { projectId: 'cd-1' });
    expect(options()).toEqual({ renderBackend: { video: { mode: 'grok' } }, modelId: 'wan-2.2' });
  });
});

/**
 * Tests for the quota-burn programmatic-I/O hooks (#3179).
 *
 * The behavior under test is WHEN the dispatch ledger is written. It used to be
 * written inside `buildTaskInput`, before the task generator had finished
 * gating — so any downstream skip (perpetual-work, branch-/issue-reconcile,
 * reference-watch, PLAN.md) permanently consumed a slot of
 * `family.maxDispatchesPerWindow` for an agent that never ran. The write now
 * happens once, post-agent, in `processTaskOutput`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordQuotaBurnDispatch = vi.fn().mockResolvedValue({});
const selectBurnCandidates = vi.fn();
const getEffectiveQuotaBurnDispatches = vi.fn().mockResolvedValue({});
const getProviderQuotas = vi.fn().mockResolvedValue([]);
const getAllProviders = vi.fn();

vi.mock('../quotaBurn.js', () => ({
  QUOTA_BURN_TASK_TYPE: 'quota-burn',
  QUOTA_BURN_DISPATCH_KEY_FIELD: 'quotaBurnDispatchKey',
  getEffectiveQuotaBurnDispatches: (...args) => getEffectiveQuotaBurnDispatches(...args),
  recordQuotaBurnDispatch: (...args) => recordQuotaBurnDispatch(...args),
  selectBurnCandidates: (...args) => selectBurnCandidates(...args),
  quotaBurnConfig: (app) => app?.taskTypeOverrides?.['quota-burn']?.taskMetadata || { families: {} },
}));
vi.mock('../providerUsage.js', () => ({ getProviderQuotas: (...args) => getProviderQuotas(...args) }));
vi.mock('../providers.js', () => ({ getAllProviders: (...args) => getAllProviders(...args) }));

const { buildTaskInput, processTaskOutput } = await import('./quotaBurnHooks.js');
const { QUOTA_BURN_DISPATCH_KEY_FIELD } = await import('../quotaBurn.js');
const { generateTasksMarkdown, parseTasksMarkdown } = await import('../../lib/taskParser.js');

const DISPATCH_KEY = 'grok:1753574400000';
const APP = { id: 'app-1', name: 'App One', taskTypeOverrides: { 'quota-burn': { taskMetadata: { families: { grok: { enabled: true, prompt: 'Burn it.' } } } } } };
const CANDIDATE = {
  family: { id: 'grok', reservePercent: 20, maxDispatchesPerWindow: 2, prompt: 'Burn it.', model: 'grok-4' },
  limit: { label: 'Weekly', scope: 'week', percentRemaining: 50 },
  hoursUntilReset: 6,
  dispatchKey: DISPATCH_KEY,
};

beforeEach(() => {
  vi.clearAllMocks();
  selectBurnCandidates.mockReturnValue([CANDIDATE]);
  getAllProviders.mockResolvedValue([{ id: 'grok-cli', enabled: true, type: 'cli' }]);
});

describe('buildTaskInput (pre-agent)', () => {
  it('hands the dispatch key back as hookMetadata WITHOUT writing the ledger', async () => {
    const input = await buildTaskInput({ app: APP });

    expect(input.hookMetadata).toEqual({ [QUOTA_BURN_DISPATCH_KEY_FIELD]: DISPATCH_KEY });
    expect(input.providerId).toBe('grok-cli');
    expect(input.model).toBe('grok-4');
    expect(input.prompt).toContain('Burn it.');
    // The whole point of #3179: nothing is recorded until an agent actually runs.
    expect(recordQuotaBurnDispatch).not.toHaveBeenCalled();
  });

  it('records nothing on any skip path', async () => {
    await expect(buildTaskInput({})).resolves.toMatchObject({ skip: { reason: 'no-app' } });

    selectBurnCandidates.mockReturnValue([]);
    await expect(buildTaskInput({ app: APP })).resolves.toMatchObject({ skip: { reason: 'no-burnable-provider-quota' } });

    selectBurnCandidates.mockReturnValue([CANDIDATE]);
    getAllProviders.mockResolvedValue([{ id: 'other', enabled: true, type: 'cli' }]);
    await expect(buildTaskInput({ app: APP })).resolves.toMatchObject({ skip: { reason: 'no-enabled-agent-provider-in-family' } });

    expect(recordQuotaBurnDispatch).not.toHaveBeenCalled();
  });

  it('selects against the ledger PLUS in-flight tasks, not the bare ledger', async () => {
    // With the write deferred to processTaskOutput, an already-queued burn is
    // invisible to the raw ledger — so candidate selection has to consult the
    // effective count or a sibling app (or a second on-demand Run) would dispatch
    // straight past maxDispatchesPerWindow.
    getEffectiveQuotaBurnDispatches.mockResolvedValue({ [DISPATCH_KEY]: 1 });

    await buildTaskInput({ app: APP });

    expect(getEffectiveQuotaBurnDispatches).toHaveBeenCalled();
    expect(selectBurnCandidates).toHaveBeenCalledWith(expect.anything(), expect.anything(), { dispatches: { [DISPATCH_KEY]: 1 } });
  });
});

describe('processTaskOutput (post-agent)', () => {
  const task = { metadata: { [QUOTA_BURN_DISPATCH_KEY_FIELD]: DISPATCH_KEY } };

  // The quota was consumed the moment the agent ran, so a failed run counts too.
  it.each([true, false])('records the dispatch exactly once on a run with success=%s', async (success) => {
    await processTaskOutput({ appId: 'app-1', success, payload: null, task });

    expect(recordQuotaBurnDispatch).toHaveBeenCalledTimes(1);
    expect(recordQuotaBurnDispatch).toHaveBeenCalledWith(DISPATCH_KEY);
  });

  it('swallows a ledger write failure instead of throwing', async () => {
    // A thrown output hook is read as `{ ran: true, threw: true }` — which
    // rejects the run's success criterion AND records a `hook-error` against the
    // per-type failure ledger that auto-parks a task type. A full disk must not
    // park quota-burn, so an environmental write failure stays a log line.
    recordQuotaBurnDispatch.mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(processTaskOutput({ appId: 'app-1', success: true, task })).resolves.toBeUndefined();
  });

  it('no-ops when the task carries no dispatch key (task predating the metadata thread)', async () => {
    await processTaskOutput({ success: true, task: { metadata: {} } });
    await processTaskOutput({ success: true, task: {} });
    await processTaskOutput({ success: true });
    await processTaskOutput();
    // A non-string key must not be coerced into a ledger entry either.
    await processTaskOutput({ success: true, task: { metadata: { [QUOTA_BURN_DISPATCH_KEY_FIELD]: { id: 'grok' } } } });
    await processTaskOutput({ success: true, task: { metadata: { [QUOTA_BURN_DISPATCH_KEY_FIELD]: '' } } });

    expect(recordQuotaBurnDispatch).not.toHaveBeenCalled();
  });

  it('reads a dispatch key that survived the COS-TASKS.md round-trip', async () => {
    // The key only reaches this hook by riding in the task's PERSISTED metadata,
    // so the markdown format has to carry it intact. Two ways it could silently
    // fail: `parseMetadataLine` keys on `\w+` (fine for the camelCase field), and
    // it splits on the FIRST colon — while a dispatch key is `<family>:<epochMs>`
    // and so contains one. A greedy value capture is what makes that work; this
    // pins it, because a regression would look like a hook that just never fires.
    const built = await buildTaskInput({ app: APP });
    const persisted = { id: 'sys-abc', status: 'pending', priority: 'MEDIUM', description: 'quota burn', metadata: { app: 'app-1', analysisType: 'quota-burn', ...built.hookMetadata } };
    const [reparsed] = parseTasksMarkdown(generateTasksMarkdown([persisted], true));

    expect(reparsed.metadata[QUOTA_BURN_DISPATCH_KEY_FIELD]).toBe(DISPATCH_KEY);

    await processTaskOutput({ appId: 'app-1', success: true, task: reparsed });
    expect(recordQuotaBurnDispatch).toHaveBeenCalledWith(DISPATCH_KEY);
  });

  it('returns no structured outcome, so quota-burn stays exit-code-judged', async () => {
    // Registering an output hook must NOT start declaring a success criterion for
    // a task type whose agent has no `.agent-done` payload contract.
    // resolveProgrammaticIoVerdict maps a non-object outcome to the "undeclared"
    // null sentinel (pinned in agentFinalization.successCriteria.test.js), which
    // keeps task-learning falling back to the exit code exactly as before.
    expect(await processTaskOutput({ appId: 'app-1', success: true, task })).toBeUndefined();
  });
});

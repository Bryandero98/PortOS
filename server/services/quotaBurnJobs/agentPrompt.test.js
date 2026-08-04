import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { apps: {}, providers: [], added: [], addResult: null };

vi.mock('../cosTaskStore.js', () => ({
  addTask: vi.fn(async (task, type) => { state.added.push({ task, type }); return state.addResult ?? { id: 'sys-1', ...task }; }),
}));
vi.mock('../apps.js', () => ({ getAppById: vi.fn(async (id) => state.apps[id] || null) }));
vi.mock('../providers.js', () => ({ getAllProviders: vi.fn(async () => state.providers) }));

const { countPending, providerForFamily, renderBurnPrompt, run } = await import('./agentPrompt.js');

const family = { id: 'grok', reservePercent: 10, maxDispatchesPerWindow: 3 };
const candidate = { hoursUntilReset: 2.4, limit: { label: 'Weekly', percentRemaining: 62 } };

beforeEach(() => {
  state.apps = { 'app-1': { id: 'app-1', name: 'Example App' } };
  state.providers = [
    { id: 'grok-cli', type: 'cli', enabled: true },
    { id: 'claude-code', type: 'cli', enabled: true },
  ];
  state.added = [];
  state.addResult = null;
});

describe('providerForFamily', () => {
  it('matches an enabled CLI/TUI provider by family name', () => {
    expect(providerForFamily(state.providers, { familyId: 'grok' })?.id).toBe('grok-cli');
  });

  it('honors an explicit pin and ignores API-type providers', () => {
    // The job exists to spend a SUBSCRIPTION window; an API provider bills per
    // token instead, so burning through it would cost real money.
    expect(providerForFamily(state.providers, { familyId: 'grok', providerId: 'claude-code' })?.id).toBe('claude-code');
    expect(providerForFamily([{ id: 'grok-api', type: 'api', enabled: true }], { familyId: 'grok' })).toBeNull();
    expect(providerForFamily([{ id: 'grok-cli', type: 'cli', enabled: false }], { familyId: 'grok' })).toBeNull();
  });

  // A burn runs unattended for minutes on the user's own subscription — the TUI
  // is the one that can be watched in Active Agents and steered mid-run. Most
  // families register both, and the CLI sorts first, so a plain `find` picked
  // the unobservable one every time.
  it('prefers the TUI provider over the CLI in the same family', () => {
    const providers = [
      { id: 'grok-cli', type: 'cli', enabled: true },
      { id: 'grok-tui', type: 'tui', enabled: true },
    ];
    expect(providerForFamily(providers, { familyId: 'grok' })?.id).toBe('grok-tui');
    // Registry order must not decide it either way.
    expect(providerForFamily([...providers].reverse(), { familyId: 'grok' })?.id).toBe('grok-tui');
    // CLI-only families still resolve — the preference is not a requirement.
    expect(providerForFamily([{ id: 'grok-cli', type: 'cli', enabled: true }], { familyId: 'grok' })?.id).toBe('grok-cli');
    // An explicit pin still outranks the preference.
    expect(providerForFamily(providers, { familyId: 'grok', providerId: 'grok-cli' })?.id).toBe('grok-cli');
  });

  // The whole `agy` family was unreachable: its providers ship as
  // `antigravity-cli` / `antigravity-tui`, neither of which contains "agy", so a
  // configured Antigravity plan reported "no enabled CLI/TUI provider" forever —
  // under a quota card that was showing a healthy window, because that card's
  // matcher checks the command.
  it('matches on the provider BINARY, not just the id — the agy/antigravity case', () => {
    const providers = [
      { id: 'antigravity-cli', type: 'cli', enabled: true, command: 'agy' },
      { id: 'antigravity-tui', type: 'tui', enabled: true, command: 'agy' },
    ];
    expect(providerForFamily(providers, { familyId: 'agy' })?.id).toBe('antigravity-tui');
    // An absolute path still resolves by basename.
    expect(providerForFamily([{ id: 'custom', type: 'tui', enabled: true, command: '/opt/tools/agy' }], { familyId: 'agy' })?.id).toBe('custom');
    // And the id substring still works for a wrapper whose basename differs.
    expect(providerForFamily([{ id: 'grok-tui', type: 'tui', enabled: true, command: 'grok-wrapper.sh' }], { familyId: 'grok' })?.id).toBe('grok-tui');
    // An unrelated family must not be dragged in by either signal.
    expect(providerForFamily(providers, { familyId: 'codex' })).toBeNull();
  });

  it('never selects an ollama-backed wrapper — a local model has no window to burn', () => {
    // `claude-ollama-tui` matches the `claude` family and IS a TUI, so the
    // preference above would reach for it. It runs a local model: nothing
    // expires, nothing is spent, and the window it was supposed to drain goes
    // unused. Same exclusion `resolveEnabledFamilies` applies to the cards.
    const providers = [
      { id: 'claude-ollama-tui', type: 'tui', enabled: true, ollamaBacked: true },
      { id: 'claude-code-tui', type: 'tui', enabled: true },
      { id: 'claude-code', type: 'cli', enabled: true },
    ];
    expect(providerForFamily(providers, { familyId: 'claude' })?.id).toBe('claude-code-tui');
    // Not even by explicit pin — it cannot do the one thing the job is for.
    expect(providerForFamily(providers, { familyId: 'claude', providerId: 'claude-ollama-tui' })).toBeNull();
    expect(providerForFamily([providers[0]], { familyId: 'claude' })).toBeNull();
  });
});

describe('countPending', () => {
  it('is ready only when the app, the prompt, and a provider all resolve', async () => {
    await expect(countPending({ params: { appId: 'app-1', prompt: 'Do the thing' }, family }))
      .resolves.toMatchObject({ count: 1 });
    await expect(countPending({ params: { appId: 'app-1' }, family }))
      .resolves.toMatchObject({ count: 0, detail: 'no work prompt configured' });
    await expect(countPending({ params: { appId: 'gone', prompt: 'x' }, family }))
      .resolves.toMatchObject({ count: 0, detail: 'managed app gone no longer exists' });
    state.providers = [];
    await expect(countPending({ params: { appId: 'app-1', prompt: 'x' }, family }))
      .resolves.toMatchObject({ count: 0, detail: 'no enabled CLI/TUI provider in the grok family' });
  });
});

describe('run', () => {
  it('queues an internal task pinned to the family provider', async () => {
    const result = await run({ params: { appId: 'app-1', prompt: 'Do the thing' }, job: { id: 'j1', label: 'Nightly', model: 'grok-4' }, family, candidate });
    expect(result.dispatched).toBe(true);
    expect(state.added[0].type).toBe('internal');
    expect(state.added[0].task).toMatchObject({
      app: 'app-1', provider: 'grok-cli', model: 'grok-4', useWorktree: true, openPR: true, simplify: true, reviewLoop: false,
    });
    expect(state.added[0].task.context).toContain('Do the thing');
  });

  it('reports a duplicate as NOT dispatched', async () => {
    // Charging the window's cap for a task that already exists would let a
    // repeatedly-colliding family exhaust its budget without adding any work.
    state.addResult = { duplicate: true, status: 'pending' };
    await expect(run({ params: { appId: 'app-1', prompt: 'x' }, job: { id: 'j1' }, family, candidate }))
      .resolves.toMatchObject({ dispatched: false, reason: 'an identical burn task is already pending' });
  });

  it('respects explicit false agent options', async () => {
    await run({ params: { appId: 'app-1', prompt: 'x', useWorktree: false, openPR: false, simplify: false }, job: { id: 'j1' }, family, candidate });
    expect(state.added[0].task).toMatchObject({ useWorktree: false, openPR: false, simplify: false });
  });

  it('keeps the auto-merge posture unless the job explicitly discards its worktree', async () => {
    // `useWorktree` + `openPR: false` merges the agent's branch onto the source
    // workspace's default branch. That is intended for a burn meant to land
    // code, so the default must not change — but a job that opts into
    // `discardWorktree` must get it, or an audit's stray commit lands unreviewed.
    await run({ params: { appId: 'app-1', prompt: 'x' }, job: { id: 'j1' }, family, candidate });
    expect(state.added[0].task).toMatchObject({ discardWorktree: false, worktreeChangesExpected: true });

    await run({ params: { appId: 'app-1', prompt: 'x', discardWorktree: true }, job: { id: 'j2' }, family, candidate });
    // A run that correctly changed nothing must also not be judged a failure by
    // the idle-complete gate, which otherwise requires a dirty tree.
    expect(state.added[1].task).toMatchObject({ discardWorktree: true, worktreeChangesExpected: false });
  });

  it('runs a no-code job in the app checkout with every commit path stripped', async () => {
    // The audit-preset posture: no worktree (it writes nothing, so there is
    // nothing to isolate — and worktree + no PR is the auto-merge posture), and
    // `noCodeOutput` so the prompt neither routes the deliverable to the
    // sentinel nor tells a no-worktree task to push to the branch it is on.
    await run({ params: { appId: 'app-1', prompt: 'x', useWorktree: false, noCodeOutput: true }, job: { id: 'j4' }, family, candidate });
    expect(state.added[0].task).toMatchObject({
      useWorktree: false, noCodeOutput: true, discardWorktree: false,
      openPR: false, simplify: false, worktreeChangesExpected: false,
    });
  });

  it('forces off the flags a discarded worktree makes impossible', async () => {
    // `openPR` defaults to true and sits one checkbox from `discardWorktree`.
    // The combination makes the spawner expect a PR that cannot exist (the
    // worktree is thrown away before any push), which downgrades the run to
    // `pr-missing` and RETRIES it — up to five agent runs of quota burned on a
    // job that already did its work. `noCodeOutput` rides along so the prompt
    // names the real output channel instead of the sentinel.
    await run({ params: { appId: 'app-1', prompt: 'x', discardWorktree: true, openPR: true, simplify: true }, job: { id: 'j3' }, family, candidate });
    expect(state.added[0].task).toMatchObject({ openPR: false, simplify: false, noCodeOutput: true });
  });
});

describe('renderBurnPrompt', () => {
  it('states the window it is spending and forbids substituting another family', () => {
    const prompt = renderBurnPrompt({ family, candidate, prompt: 'Ship the backlog' });
    expect(prompt).toContain('resets in about 3 hours');
    expect(prompt).toContain('remaining: 62%');
    expect(prompt).toContain('Do not use another provider family as a substitute.');
    expect(prompt.endsWith('Ship the backlog')).toBe(true);
  });
});

describe('probe → run passthrough', () => {
  it('reuses the probe\'s lookups instead of resolving twice', async () => {
    const { getAppById } = await import('../apps.js');
    const probe = await countPending({ params: { appId: 'app-1', prompt: 'x' }, family });
    getAppById.mockClear();
    await run({ params: { appId: 'app-1', prompt: 'x' }, job: { id: 'j1' }, family, candidate, context: probe.context });
    expect(getAppById).not.toHaveBeenCalled();
    expect(state.added).toHaveLength(1);
  });

  it('still resolves on its own when called with no probe (the force path)', async () => {
    await run({ params: { appId: 'app-1', prompt: 'x' }, job: { id: 'j1' }, family, candidate });
    expect(state.added).toHaveLength(1);
  });
});

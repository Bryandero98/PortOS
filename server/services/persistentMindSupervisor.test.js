import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPersistentMindState, PERSISTENT_MIND_LIMITS } from '../lib/persistentMind.js';

const mock = vi.hoisted(() => ({
  root: null,
  scheduled: new Map(),
  emitted: [],
  budget: { withinBudget: true, exceeded: null },
  recordUsage: vi.fn(async () => {}),
  acquireSlot: vi.fn(async () => ({ ok: true, release: vi.fn() })),
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mock.root),
  saveState: vi.fn(async (state) => { mock.root = state; }),
  withStateLock: vi.fn(async (fn) => fn()),
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn((...args) => mock.emitted.push(args)) },
  emitLog: vi.fn(),
}));

vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn((config) => {
    mock.scheduled.set(config.id, config);
    return config;
  }),
  cancel: vi.fn((id) => mock.scheduled.delete(id)),
}));

vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(async () => mock.budget),
  recordDomainUsage: (...args) => mock.recordUsage(...args),
}));

vi.mock('./cosLocalEndpointSlots.js', () => ({
  acquireLocalEndpointProviderSlot: (...args) => mock.acquireSlot(...args),
}));

const supervisor = await import('./persistentMindSupervisor.js');

const makeRoot = () => ({
  paused: false,
  config: { domainAutonomy: { cos: 'execute' } },
  agents: {},
  persistentMind: createDefaultPersistentMindState(),
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('persistent mind supervisor', () => {
  beforeEach(() => {
    mock.root = makeRoot();
    mock.scheduled.clear();
    mock.emitted.length = 0;
    mock.budget = { withinBudget: true, exceeded: null };
    mock.recordUsage.mockClear();
    mock.acquireSlot.mockReset();
    mock.acquireSlot.mockResolvedValue({ ok: true, release: vi.fn() });
    supervisor.__resetPersistentMindSupervisorForTests();
  });

  it('is silent on boot and refuses start until explicitly enabled', async () => {
    const prepare = vi.fn();
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({ prepare, run });

    await supervisor.initializePersistentMindSupervisor();
    expect(mock.scheduled.size).toBe(0);
    expect(await supervisor.startPersistentMind()).toEqual({ success: false, error: 'Persistent mind is disabled' });
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('parks an explicitly started mind instead of spinning when no provider adapter is registered', async () => {
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.drainPersistentMind();

    expect(mock.root.persistentMind.status).toBe('degraded');
    expect(mock.root.persistentMind.pauseReason).toBe('Persistent mind provider is not configured');
    expect(Date.parse(mock.root.persistentMind.nextEligibleWakeAt)).toBeGreaterThan(Date.now());
    expect(mock.scheduled.get(supervisor.PERSISTENT_MIND_WAKE_EVENT_ID).delayMs).toBeGreaterThan(1_000);
  });

  it('accepts a message durably, deduplicates retries, and runs only one turn', async () => {
    const pending = deferred();
    const prepare = vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' }, model: 'example-model', effort: 'high' }));
    const run = vi.fn(() => pending.promise);
    await supervisor.registerPersistentMindTurnAdapter({ prepare, run });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();

    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Please review this.' }))
      .toEqual({ success: true, duplicate: false, messageId: 'message-1' });
    expect(await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Please review this.' }))
      .toEqual({ success: true, duplicate: true, messageId: 'message-1' });

    const firstDrain = supervisor.drainPersistentMind();
    const secondDrain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0].wake).toMatchObject({ kind: 'message', message: { id: 'message-1' } });
    pending.resolve({});
    await Promise.all([firstDrain, secondDrain]);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(mock.acquireSlot).toHaveBeenCalledTimes(1);
    expect(mock.root.persistentMind.activeTurn).toBeNull();
    expect(mock.root.persistentMind.recentMessageIds).toContain('message-1');
    expect(mock.recordUsage).toHaveBeenCalledWith('cos', expect.objectContaining({ actions: 1 }));
  });

  it('recovers an orphaned turn without losing or duplicating its accepted message', async () => {
    const message = { id: 'message-1', text: 'Do not lose me.', createdAt: new Date(1).toISOString() };
    mock.root.persistentMind = {
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'thinking',
      activeTurn: {
        id: 'turn-orphan',
        wake: { kind: 'message', message },
        startedAt: new Date(1).toISOString(),
        heartbeatAt: new Date(1).toISOString(),
        providerId: 'example-cloud',
        model: 'example-model',
        effort: 'high',
      },
    };

    const recovered = await supervisor.initializePersistentMindSupervisor();
    expect(recovered.activeTurn).toBeNull();
    expect(recovered.status).toBe('interrupted');
    expect(recovered.queuedMessages).toEqual([message]);
    expect(recovered.nextEligibleWakeAt).not.toBeNull();
    expect(mock.scheduled.has(supervisor.PERSISTENT_MIND_WATCHDOG_EVENT_ID)).toBe(true);
  });

  it('requeues a message and degrades visibly when the pinned provider is unavailable', async () => {
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: false, error: 'Pinned provider unavailable' })),
      run: vi.fn(),
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Wait for the configured provider.' });
    await supervisor.drainPersistentMind();

    expect(mock.root.persistentMind.status).toBe('degraded');
    expect(mock.root.persistentMind.pauseReason).toBe('Pinned provider unavailable');
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.nextEligibleWakeAt).not.toBeNull();
    expect(mock.acquireSlot).not.toHaveBeenCalled();
  });

  it('holds queued work durably when the CoS budget is exhausted', async () => {
    const prepare = vi.fn();
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({ prepare, run });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Wait for tomorrow.' });
    mock.budget = { withinBudget: false, exceeded: 'actions' };

    await supervisor.drainPersistentMind();

    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.pauseReason).toBe('CoS actions budget exhausted');
    expect(mock.root.persistentMind.nextEligibleWakeAt).not.toBeNull();
  });

  it('requeues a claimed message when the shared local endpoint has no slot', async () => {
    const run = vi.fn();
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-local', endpoint: 'http://127.0.0.1:1234' } })),
      run,
    });
    mock.acquireSlot.mockResolvedValueOnce({ ok: false, reason: 'local endpoint localhost:1234 is at capacity (1/1)' });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Wait for capacity.' });

    await supervisor.drainPersistentMind();

    expect(run).not.toHaveBeenCalled();
    expect(mock.root.persistentMind.status).toBe('waiting');
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.pauseReason).toContain('at capacity');
  });

  it('watchdog interruption aborts and requeues a stale turn without starting a second copy', async () => {
    const run = vi.fn(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await supervisor.registerPersistentMindTurnAdapter({
      prepare: vi.fn(async () => ({ ok: true, provider: { id: 'example-cloud' } })),
      run,
    });
    await supervisor.setPersistentMindEnabled(true);
    await supervisor.startPersistentMind();
    await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Watch this turn.' });
    const drain = supervisor.drainPersistentMind();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    mock.root.persistentMind.activeTurn.heartbeatAt = new Date(
      Date.now() - PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS
    ).toISOString();
    await expect(supervisor.checkPersistentMindWatchdog()).resolves.toEqual({ interrupted: true });
    await drain;

    expect(run).toHaveBeenCalledTimes(1);
    expect(mock.root.persistentMind.activeTurn).toBeNull();
    expect(mock.root.persistentMind.queuedMessages.map((item) => item.id)).toEqual(['message-1']);
    expect(mock.root.persistentMind.status).toBe('interrupted');
  });

  it('coalesces self-wakes and rejects a recursive wake without a completed source turn', async () => {
    mock.root.persistentMind = {
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'idle',
      lastCompletedTurnId: 'turn-1',
    };
    expect(await supervisor.requestPersistentMindWake({ sourceTurnId: 'turn-0', reason: 'stale' }))
      .toEqual({ success: false, error: 'Self-wake must reference the last completed turn' });
    const first = await supervisor.requestPersistentMindWake({ sourceTurnId: 'turn-1', reason: 'first' });
    const second = await supervisor.requestPersistentMindWake({ sourceTurnId: 'turn-1', reason: 'newest' });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(mock.root.persistentMind.selfWake.reason).toBe('newest');
  });
});

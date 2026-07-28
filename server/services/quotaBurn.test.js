import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectQuotaBurn, selectBurnCandidates } from './quotaBurn.js';
import { sanitizeTaskMetadata } from '../lib/validation.js';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const config = {
  families: {
    grok: { enabled: true, prompt: 'Animate eligible sprites.', resetWithinHours: 24, reservePercent: 20, maxDispatchesPerWindow: 2 },
    codex: { enabled: true, prompt: 'Prepare assets.', resetWithinHours: 24, reservePercent: 0, priority: 1 },
  },
};
const quota = (family, resetsAt, percentRemaining = 50, extras = {}) => ({
  family, supported: true, limits: [{ key: 'week', scope: 'week', label: 'Weekly', resetsAt, percentRemaining }], ...extras,
});

describe('selectBurnCandidates', () => {
  it('selects burnable windows by reset time then priority', () => {
    const candidates = selectBurnCandidates([
      quota('codex', '2026-07-27T00:00:00.000Z'),
      quota('grok', '2026-07-26T18:00:00.000Z'),
    ], config, { now: NOW });
    expect(candidates.map((candidate) => candidate.family.id)).toEqual(['grok', 'codex']);
  });

  it('skips unknown, out-of-window, reserved, unsupported, and exhausted windows', () => {
    expect(selectBurnCandidates([quota('grok', null)], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-28T12:00:00.000Z')], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z', 20)], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z', 50, { supported: false })], config, { now: NOW })).toEqual([]);
    const selected = selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], config, { now: NOW })[0];
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], config, {
      now: NOW, dispatches: { [selected.dispatchKey]: 2 },
    })).toEqual([]);
  });
});

describe('detectQuotaBurn', () => {
  it('parks an empty configuration without reading provider usage', async () => {
    const getQuotas = vi.fn();
    await expect(detectQuotaBurn({ taskTypeOverrides: {} }, { getQuotas, now: NOW }))
      .resolves.toMatchObject({ actionable: false, reason: 'no-enabled-families' });
    expect(getQuotas).not.toHaveBeenCalled();
  });

  it('reports a transient result when every configured quota probe failed', async () => {
    await expect(detectQuotaBurn({ taskTypeOverrides: { 'quota-burn': { taskMetadata: config } } }, {
      getQuotas: async () => [quota('grok', null, 0, { error: 'signed out' })], now: NOW,
    })).resolves.toMatchObject({ actionable: false, transient: true });
  });
});

describe('quota-burn metadata validation', () => {
  it('keeps valid family configuration and rejects unknown families or unsafe reserves', () => {
    expect(sanitizeTaskMetadata({ families: { grok: { enabled: true, reservePercent: 20 } } }))
      .toMatchObject({ families: { grok: { enabled: true, reservePercent: 20 } } });
    expect(sanitizeTaskMetadata({ families: { unknown: { enabled: true } } })).toBeNull();
    expect(sanitizeTaskMetadata({ families: { grok: { reservePercent: 101 } } })).toBeNull();
  });
});

/**
 * The window cap is only honest if a burn that has been QUEUED but whose agent
 * has not finalized yet still holds its slot. The ledger write moved post-agent
 * (#3179), so the raw ledger no longer covers that gap on its own.
 */
describe('getEffectiveQuotaBurnDispatches', () => {
  const loadStore = async (tasks, { fail = false } = {}) => {
    vi.resetModules();
    vi.doMock('./cosTaskStore.js', () => ({
      getCosTasks: fail ? async () => { throw new Error('unreadable'); } : async () => ({ tasks }),
    }));
    vi.doMock('../lib/fileUtils.js', async (importActual) => ({
      ...(await importActual()),
      readJSONFile: async () => ({ 'grok:1': 1 }),
    }));
    return import('./quotaBurn.js');
  };

  const burnTask = (status, key) => ({ id: `sys-${status}`, status, metadata: { quotaBurnDispatchKey: key } });

  afterEach(() => { vi.doUnmock('./cosTaskStore.js'); vi.doUnmock('../lib/fileUtils.js'); vi.resetModules(); });

  it('adds pending and in_progress burns on top of the persisted ledger', async () => {
    const { getEffectiveQuotaBurnDispatches } = await loadStore([
      burnTask('pending', 'grok:1'),
      burnTask('in_progress', 'codex:2'),
    ]);
    // grok:1 = 1 persisted + 1 queued; codex:2 = 0 persisted + 1 running.
    await expect(getEffectiveQuotaBurnDispatches()).resolves.toEqual({ 'grok:1': 2, 'codex:2': 1 });
  });

  it('ignores terminal tasks and tasks carrying no dispatch key', async () => {
    const { getEffectiveQuotaBurnDispatches } = await loadStore([
      burnTask('completed', 'grok:1'),
      burnTask('blocked', 'grok:1'),
      { id: 'sys-other', status: 'pending', metadata: { analysisType: 'performance' } },
      { id: 'sys-empty', status: 'pending', metadata: { quotaBurnDispatchKey: '' } },
    ]);
    // A completed burn already wrote its ledger entry — counting it would
    // double-charge the window; a blocked one never dispatched.
    await expect(getEffectiveQuotaBurnDispatches()).resolves.toEqual({ 'grok:1': 1 });
  });

  it('degrades to the ledger alone when the task file cannot be read', async () => {
    const { getEffectiveQuotaBurnDispatches } = await loadStore([], { fail: true });
    await expect(getEffectiveQuotaBurnDispatches()).resolves.toEqual({ 'grok:1': 1 });
  });

  it('excludes ignoreTaskId so a completing burn is not counted twice', async () => {
    // The drain-on-completion refill runs between the output hook's ledger write
    // and the completion flow's updateTask, so the finished burn is BOTH in the
    // ledger and still `in_progress`. Counting both would consume two slots for
    // one run — a family capped at 2 would stop after one and miss its window.
    const tasks = [{ id: 'sys-finishing', status: 'in_progress', metadata: { quotaBurnDispatchKey: 'grok:1' } }];
    const { getEffectiveQuotaBurnDispatches } = await loadStore(tasks);

    await expect(getEffectiveQuotaBurnDispatches()).resolves.toEqual({ 'grok:1': 2 });
    await expect(getEffectiveQuotaBurnDispatches({ ignoreTaskId: 'sys-finishing' })).resolves.toEqual({ 'grok:1': 1 });
  });
});

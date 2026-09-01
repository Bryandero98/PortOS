import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFile } from 'fs/promises';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-peer-usage-' });
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// peerUsage resolves this machine's identity through a dynamic import of
// instances.js (kept off dataSync's module graph); the digest itself is
// whatever usage.js currently holds.
const self = { instanceId: 'inst-self', name: 'Workshop' };
// importActual so UNKNOWN_INSTANCE_ID stays the REAL sentinel — a hand-written
// copy here would let the real one drift and silently stop being filtered.
vi.mock('./instances.js', async () => ({
  ...(await vi.importActual('./instances.js')),
  getSelf: vi.fn(async () => self),
}));

let localUsage;
vi.mock('./usage.js', async () => {
  const actual = await vi.importActual('./usage.js');
  return { ...actual, getUsage: () => localUsage };
});

const { buildUsageDigest, getUsage } = await import('./usage.js');
const {
  getUsageSnapshot,
  applyUsageRemote,
  getFleetUsage,
  PEER_USAGE_FILE,
} = await import('./peerUsage.js');

afterAll(cleanup);

// A minimal but realistic usage shape: one provider/model day bucket plus the
// all-time totals the report folds in on an unbounded window.
const usageFixture = ({ day = '2026-08-30', tokensOut = 1000, lastUpdated = '2026-08-30T12:00:00.000Z' } = {}) => ({
  totalSessions: 2,
  totalMessages: 5,
  totalToolCalls: 7,
  totalTokens: { input: 500, output: tokensOut },
  byProvider: { anthropic: { name: 'Anthropic', sessions: 2, messages: 5, tokens: tokensOut } },
  byModel: { 'claude-opus-5': { sessions: 2, messages: 5, tokens: tokensOut } },
  dailyActivity: {
    [day]: {
      sessions: 2,
      messages: 5,
      tokens: tokensOut,
      byProvider: {
        anthropic: {
          name: 'Anthropic',
          sessions: 2,
          messages: 5,
          tokensIn: 500,
          tokensOut,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          source: 'measured',
          byModel: {
            'claude-opus-5': {
              sessions: 2, messages: 5, tokensIn: 500, tokensOut,
              cacheReadTokens: 0, cacheWriteTokens: 0, source: 'measured',
            },
          },
        },
      },
    },
  },
  monthlyActivity: {},
  hourlyActivity: Array(24).fill(0),
  earliestActivityDay: day,
  lastUpdated,
  // Machine-local idempotency bookkeeping keyed by LOCAL run ids — meaningless
  // on a peer, and the largest field in the file.
  reconciledRuns: { 'run-1': '2026-08-30T12:00:00.000Z' },
});

const peerEntry = (overrides = {}) => ({
  instanceId: 'inst-peer',
  name: 'Studio',
  capturedAt: '2026-08-30T09:00:00.000Z',
  usage: buildUsageDigest(usageFixture({ tokensOut: 4000 })),
  ...overrides,
});

const readStoreFile = async () => JSON.parse(await readFile(PEER_USAGE_FILE, 'utf8'));

beforeEach(async () => {
  localUsage = usageFixture();
  // Reset the store between cases — every test starts with no peer digests.
  const { atomicWrite } = await import('../lib/fileUtils.js');
  await atomicWrite(PEER_USAGE_FILE, { instances: {} });
});

describe('federated usage digest', () => {
  // The wire shape is an allowlist. `reconciledRuns` is local run-id bookkeeping
  // (meaningless on a peer, and the biggest field in the file); all-time
  // byProvider/byModel are a coarser restatement of the day buckets that already
  // ride along. Both would otherwise be pure recurring wire weight.
  it('ships an allowlist, not the whole usage file', () => {
    const digest = buildUsageDigest(usageFixture());
    expect(Object.keys(digest).sort()).toEqual([
      'dailyActivity', 'earliestActivityDay', 'hourlyActivity', 'lastUpdated',
      'monthlyActivity', 'totalMessages', 'totalSessions', 'totalTokens', 'totalToolCalls',
    ]);
  });

  it('folds days past the wire retention window into their month, preserving counts', () => {
    const source = usageFixture({ day: '2026-01-05' });
    const digest = buildUsageDigest(source, { retentionDays: 30, now: new Date('2026-08-30T00:00:00Z') });
    expect(digest.dailyActivity['2026-01-05']).toBeUndefined();
    expect(digest.monthlyActivity['2026-01'].byProvider.anthropic.tokensOut).toBe(1000);
    // Pure: the rollup runs over a shallow copy, so the caller's maps survive.
    expect(source.dailyActivity['2026-01-05']).toBeTruthy();
    expect(source.monthlyActivity).toEqual({});
  });
});

describe('usage sync category', () => {
  it('publishes this instance under its own id', async () => {
    const { data } = await getUsageSnapshot();
    expect(Object.keys(data.instances)).toEqual(['inst-self']);
    expect(data.instances['inst-self'].name).toBe('Workshop');
    expect(data.instances['inst-self'].capturedAt).toBe('2026-08-30T12:00:00.000Z');
  });

  it('keeps the checksum stable while local usage has not moved', async () => {
    const a = await getUsageSnapshot();
    const b = await getUsageSnapshot();
    expect(b.checksum).toBe(a.checksum);
  });

  it('stores a peer digest side by side instead of summing it into local usage', async () => {
    const result = await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    expect(result).toEqual({ applied: true, count: 1 });

    const store = await readStoreFile();
    expect(store.instances['inst-peer'].usage.totalTokens.output).toBe(4000);
    // The local file's own counters are untouched — summing them would
    // double-count on the very next round trip.
    expect(localUsage.totalTokens.output).toBe(1000);
    const { data } = await getUsageSnapshot();
    expect(data.instances['inst-self'].usage.totalTokens.output).toBe(1000);
  });

  it('re-applying the same snapshot is a no-op', async () => {
    const snapshot = { instances: { 'inst-peer': peerEntry() } };
    await applyUsageRemote(snapshot);
    expect(await applyUsageRemote(snapshot)).toEqual({ applied: false, count: 0 });
  });

  it('replaces a peer digest only when the incoming one is newer', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });

    const stale = peerEntry({
      capturedAt: '2026-08-29T00:00:00.000Z',
      usage: buildUsageDigest(usageFixture({ tokensOut: 1 })),
    });
    expect(await applyUsageRemote({ instances: { 'inst-peer': stale } })).toEqual({ applied: false, count: 0 });
    expect((await readStoreFile()).instances['inst-peer'].usage.totalTokens.output).toBe(4000);

    const fresh = peerEntry({
      capturedAt: '2026-08-31T00:00:00.000Z',
      usage: buildUsageDigest(usageFixture({ tokensOut: 9000 })),
    });
    expect(await applyUsageRemote({ instances: { 'inst-peer': fresh } })).toEqual({ applied: true, count: 1 });
    expect((await readStoreFile()).instances['inst-peer'].usage.totalTokens.output).toBe(9000);
  });

  it('ignores a peer echoing a stale copy of US back', async () => {
    const echo = peerEntry({
      instanceId: 'inst-self',
      name: 'Workshop',
      capturedAt: '2099-01-01T00:00:00.000Z',
      usage: buildUsageDigest(usageFixture({ tokensOut: 999999 })),
    });
    expect(await applyUsageRemote({ instances: { 'inst-self': echo } })).toEqual({ applied: false, count: 0 });
    const { data } = await getUsageSnapshot();
    expect(data.instances['inst-self'].usage.totalTokens.output).toBe(1000);
  });

  it('rejects an entry whose instanceId does not match the key it arrived under', async () => {
    const spoofed = peerEntry({ instanceId: 'inst-self' });
    expect(await applyUsageRemote({ instances: { 'inst-peer': spoofed } })).toEqual({ applied: false, count: 0 });
  });

  it('forwards known peer digests so a third instance propagates through us', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const { data } = await getUsageSnapshot();
    expect(Object.keys(data.instances).sort()).toEqual(['inst-peer', 'inst-self']);
  });
});

describe('fleet report', () => {
  it('is empty until a peer digest has synced', async () => {
    expect(await getFleetUsage({ providers: [] })).toEqual({ instances: [], totals: null });
  });

  it('reports one row per instance plus the combined totals', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const fleet = await getFleetUsage({ providers: [] });

    expect(fleet.instances.map((i) => i.instanceId)).toEqual(['inst-self', 'inst-peer']);
    expect(fleet.instances[0].self).toBe(true);
    expect(fleet.instances[1].capturedAt).toBe('2026-08-30T09:00:00.000Z');
    expect(fleet.totals.tokensOut).toBe(5000);
    expect(fleet.totals.sessions).toBe(4);
  });

  // The wire digest folds days past its retention window into WHOLE months, and
  // buildUsageReport includes a month bucket whole whenever its month overlaps
  // the range. Routing this machine's own row through the digest therefore made
  // the "This machine" row report a whole month where the headline above it
  // reported ten days — measured at 10x. The self row must read the live maps.
  it('prices this machine from live usage, not from its own wire digest', async () => {
    localUsage = usageFixture({ day: '2026-01-05', tokensOut: 1000 });
    localUsage.dailyActivity['2026-01-15'] = { sessions: 1, messages: 1, tokens: 100, byProvider: {
      anthropic: { name: 'Anthropic', sessions: 1, messages: 1, tokensIn: 50, tokensOut: 100, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'measured', byModel: {} },
    } };
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });

    const fleet = await getFleetUsage({ from: '2026-01-10', to: '2026-01-20', providers: [] });
    const selfRow = fleet.instances.find((i) => i.self);
    // Only the 2026-01-15 bucket is in range; the 2026-01-05 one is not.
    expect(selfRow.totals.tokensOut).toBe(100);
  });

  it('scopes every instance to the same report window', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const outside = await getFleetUsage({ from: '2026-09-01', to: '2026-09-30', providers: [] });
    expect(outside.totals.tokensOut).toBe(0);
  });
});

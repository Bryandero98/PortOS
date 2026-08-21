import { describe, it, expect } from 'vitest';
import {
  FEDERATED_MEDIA_KINDS,
  FEDERATED_MEDIA_STATE_HELP,
  federatedMediaModelKey,
  peerMediaProviderConfig,
  resolvePeerMediaReadiness,
} from './federatedMediaReadiness.js';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

const peer = (overrides = {}) => ({
  id: 'peer-1',
  name: 'render-box',
  status: 'online',
  mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax', modelId: 'music-3' }] },
  mediaProviderStatus: {
    checkedAt: iso(-1000),
    state: 'ready',
    reason: null,
    freshUntil: iso(60_000),
    snapshot: {
      queue: { running: 1, queued: 0, totalActive: 1, maxQueuedJobs: 4, accepting: true },
      capabilities: [{ kind: 'audio', engine: 'minimax', modelId: 'music-3', ready: true }],
    },
  },
  ...overrides,
});

describe('resolvePeerMediaReadiness', () => {
  it('reports a fresh ready provider with its queue and capabilities', () => {
    const readiness = resolvePeerMediaReadiness(peer(), { now: NOW });
    expect(readiness).toMatchObject({ configured: true, state: 'ready', label: 'ready', tone: 'success', help: null });
    expect(readiness.queue.maxQueuedJobs).toBe(4);
    expect(readiness.capabilities).toHaveLength(1);
    expect(readiness.kinds).toEqual(['audio']);
    expect(readiness.modelCount).toBe(1);
  });

  // The load-bearing case: the probe concluded `ready`, then the snapshot
  // expired while the record sat on disk. The server would refuse to submit
  // against it, so the UI must not keep advertising it as available.
  it('downgrades an expired ready snapshot to stale', () => {
    const readiness = resolvePeerMediaReadiness(peer(), { now: NOW + 61_000 });
    expect(readiness.state).toBe('stale');
    expect(readiness.label).toBe('stale');
    expect(readiness.tone).toBe('warning');
    expect(readiness.help).toBe(FEDERATED_MEDIA_STATE_HELP.stale);
  });

  it('keeps a snapshot fresh right up to its expiry instant', () => {
    expect(resolvePeerMediaReadiness(peer(), { now: NOW + 60_000 }).state).toBe('ready');
  });

  it('leaves a state with no freshness window alone', () => {
    const unreachable = peer({
      mediaProviderStatus: { checkedAt: iso(-1000), state: 'unreachable', reason: 'timeout', freshUntil: null, snapshot: null },
    });
    const readiness = resolvePeerMediaReadiness(unreachable, { now: NOW + 10_000_000 });
    expect(readiness.state).toBe('unreachable');
    expect(readiness.help).toBe(FEDERATED_MEDIA_STATE_HELP.unreachable);
    expect(readiness.queue).toBeNull();
    expect(readiness.capabilities).toEqual([]);
  });

  it('reads a peer with no provider config as off, not as broken', () => {
    const readiness = resolvePeerMediaReadiness({ id: 'p', status: 'online' }, { now: NOW });
    expect(readiness).toMatchObject({ configured: false, state: null, label: 'off', tone: 'note', help: null });
    expect(readiness.modelCount).toBe(0);
  });

  // An opted-in peer that has not been probed yet is not the same claim as a
  // peer with nothing to offer.
  it('reads an unprobed opted-in peer as checking', () => {
    const readiness = resolvePeerMediaReadiness(peer({ mediaProviderStatus: undefined }), { now: NOW });
    expect(readiness.label).toBe('checking');
    expect(readiness.state).toBeNull();
  });

  // The server rejects a submission to a disabled peer with
  // MEDIA_PROVIDER_PEER_DISABLED before it looks at capacity at all, so a
  // healthy cached snapshot must not keep advertising it as ready.
  it('reports a disabled peer connection as disabled despite a ready snapshot', () => {
    const readiness = resolvePeerMediaReadiness(peer({ enabled: false }), { now: NOW });
    expect(readiness.label).toBe('peer disabled');
    expect(readiness.tone).toBe('warning');
    expect(readiness.help).toMatch(/switched off/i);
  });

  it('treats a peer with no explicit enabled flag as enabled', () => {
    expect(resolvePeerMediaReadiness(peer(), { now: NOW }).label).toBe('ready');
  });

  it('reports an offline peer as offline rather than as a provider fault', () => {
    const readiness = resolvePeerMediaReadiness(peer({ status: 'offline' }), { now: NOW });
    expect(readiness.label).toBe('peer offline');
    expect(readiness.tone).toBe('warning');
  });

  it('surfaces the remedy for a disabled provider', () => {
    const disabled = peer({
      mediaProviderStatus: { checkedAt: iso(-1), state: 'disabled', reason: 'MEDIA_PROVIDER_DISABLED', freshUntil: null, snapshot: null },
    });
    expect(resolvePeerMediaReadiness(disabled, { now: NOW }).help).toBe(FEDERATED_MEDIA_STATE_HELP.disabled);
  });

  it('lists only the kinds that actually have an allowlisted model', () => {
    const multi = peer({
      mediaProvider: {
        enabled: true,
        audioModels: [{ engine: 'minimax', modelId: 'music-3' }],
        imageModels: [],
        videoModels: [{ engine: 'local', modelId: 'ltx2' }],
      },
    });
    const readiness = resolvePeerMediaReadiness(multi, { now: NOW });
    expect(readiness.kinds).toEqual(['audio', 'video']);
    expect(readiness.modelCount).toBe(2);
  });

  it('tolerates a malformed stored config without throwing', () => {
    const junk = resolvePeerMediaReadiness(
      { id: 'p', status: 'online', mediaProvider: 'nope', mediaProviderStatus: [] },
      { now: NOW },
    );
    expect(junk.configured).toBe(false);
    expect(junk.capabilities).toEqual([]);
  });
});

describe('peerMediaProviderConfig', () => {
  it('always returns a list for every known kind', () => {
    const config = peerMediaProviderConfig({ mediaProvider: { enabled: true } });
    for (const { kind } of FEDERATED_MEDIA_KINDS) expect(config.models[kind]).toEqual([]);
  });
});

describe('federatedMediaModelKey', () => {
  // Matches the server's own NUL-separated key. A printable separator would let
  // an engine name containing it collide with a different engine/model pair.
  it('separates engine from model with NUL', () => {
    expect(federatedMediaModelKey({ engine: 'local', modelId: 'ltx2' })).toBe('local\u0000ltx2');
    expect(federatedMediaModelKey({ engine: 'a', modelId: 'b-c' }))
      .not.toBe(federatedMediaModelKey({ engine: 'a-b', modelId: 'c' }));
  });
});

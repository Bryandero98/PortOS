import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPeers = vi.fn();
vi.mock('../instances.js', () => ({ getPeers: (...args) => getPeers(...args) }));

import {
  assertMediaRoutingConfig,
  normalizeMediaRoutingConfig,
  sanitizeRoute,
} from './routingPolicy.js';

const ROUTE = { peerId: 'peer-1', engine: 'comfy', modelId: 'sdxl-base' };

const peerWith = (overrides = {}) => ({
  id: 'peer-1',
  name: 'Render Box',
  host: 'render-box.tailnet-example.ts.net',
  enabled: true,
  mediaProvider: {
    enabled: true,
    imageModels: [{ engine: 'comfy', modelId: 'sdxl-base' }],
    videoModels: [],
  },
  ...overrides,
});

// The assertion throws a ServerError; return its shape so each case can pin the
// code a user would actually see rather than just "it rejected".
const failureOf = async (routing, peers = [peerWith()]) => {
  getPeers.mockResolvedValue(peers);
  return assertMediaRoutingConfig(routing).then(
    () => null,
    (error) => ({ code: error.code, status: error.status, message: error.message }),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sanitizeRoute', () => {
  it('trims a complete route', () => {
    expect(sanitizeRoute({ peerId: ' p ', engine: ' e ', modelId: ' m ' }))
      .toEqual({ peerId: 'p', engine: 'e', modelId: 'm' });
  });

  it('rejects a half-written route rather than resolving it to "peer, whatever model"', () => {
    for (const partial of [{ peerId: 'p' }, { peerId: 'p', engine: 'e' }, { engine: 'e', modelId: 'm' }, null, 'x']) {
      expect(sanitizeRoute(partial)).toBeNull();
    }
  });
});

describe('normalizeMediaRoutingConfig', () => {
  it('reports no route for a settings object that has none', () => {
    expect(normalizeMediaRoutingConfig(undefined)).toEqual({ image: null, video: null });
    expect(normalizeMediaRoutingConfig({ federation: {} })).toEqual({ image: null, video: null });
  });

  it('drops a kind this build cannot route', () => {
    const config = normalizeMediaRoutingConfig({
      federation: { mediaRouting: { audio: ROUTE, image: ROUTE } },
    });
    expect(config.image).toEqual(ROUTE);
    expect(config.audio).toBeUndefined();
  });
});

describe('assertMediaRoutingConfig — nothing to check', () => {
  it('accepts an absent or empty routing map without reading the peer registry', async () => {
    for (const routing of [undefined, null, {}, { image: null, video: null }]) {
      await expect(assertMediaRoutingConfig(routing)).resolves.toBeUndefined();
    }
    expect(getPeers).not.toHaveBeenCalled();
  });

  // The whole point of a fail-closed save gate is that it must never make a bad
  // configuration permanent: clearing has to work even when the peer behind the
  // old route is long gone.
  it('always allows clearing a route, even with no peers registered at all', async () => {
    getPeers.mockResolvedValue([]);
    await expect(assertMediaRoutingConfig({ image: null })).resolves.toBeUndefined();
  });

  it('ignores a kind this build cannot route', async () => {
    getPeers.mockResolvedValue([]);
    await expect(assertMediaRoutingConfig({ audio: ROUTE })).resolves.toBeUndefined();
  });
});

describe('assertMediaRoutingConfig — refuses a route that could never run', () => {
  it('accepts a route to an allowlisted model on an enabled tailnet provider', async () => {
    expect(await failureOf({ image: ROUTE })).toBeNull();
  });

  it('rejects a half-written route', async () => {
    expect(await failureOf({ image: { peerId: 'peer-1' } }))
      .toMatchObject({ code: 'MEDIA_ROUTING_INVALID', status: 400 });
  });

  it('rejects a peer that is not registered here', async () => {
    expect(await failureOf({ image: { ...ROUTE, peerId: 'ghost' } }))
      .toMatchObject({ code: 'MEDIA_PROVIDER_PEER_NOT_FOUND', status: 404 });
  });

  it('rejects a peer whose connection is switched off', async () => {
    expect(await failureOf({ image: ROUTE }, [peerWith({ enabled: false })]))
      .toMatchObject({ code: 'MEDIA_PROVIDER_PEER_DISABLED', status: 409 });
  });

  it('rejects a peer that is not enabled as a media provider', async () => {
    const peer = peerWith({ mediaProvider: { enabled: false, imageModels: [{ engine: 'comfy', modelId: 'sdxl-base' }] } });
    expect(await failureOf({ image: ROUTE }, [peer]))
      .toMatchObject({ code: 'MEDIA_PROVIDER_NOT_CONFIGURED', status: 409 });
  });

  it('rejects a model that is not allowlisted for that kind on that peer', async () => {
    expect(await failureOf({ image: { ...ROUTE, modelId: 'never-allowlisted' } }))
      .toMatchObject({ code: 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED', status: 403 });
  });

  // The allowlist is keyed on the (engine, modelId) PAIR, so a matching model
  // id under a different engine is a different capability.
  it('rejects a matching model id under an engine that was never allowlisted', async () => {
    expect(await failureOf({ image: { ...ROUTE, engine: 'other-engine' } }))
      .toMatchObject({ code: 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED', status: 403 });
  });

  it('rejects a kind whose allowlist is empty even though another kind has one', async () => {
    expect(await failureOf({ video: ROUTE }))
      .toMatchObject({ code: 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED', status: 403 });
  });

  // ADR 2026-08-20-federated-visual-prompts rule 5.
  it('rejects a peer reachable outside the tailnet', async () => {
    const lanPeer = peerWith({ host: undefined, address: '192.0.2.10' });
    expect(await failureOf({ image: ROUTE }, [lanPeer]))
      .toMatchObject({ code: 'MEDIA_ROUTING_PEER_NOT_TAILNET', status: 403 });
  });

  it('accepts a CGNAT-addressed peer', async () => {
    expect(await failureOf({ image: ROUTE }, [peerWith({ host: undefined, address: '100.64.0.5' })]))
      .toBeNull();
  });

  it('checks every kind in the patch, not just the first', async () => {
    const peer = peerWith({
      mediaProvider: {
        enabled: true,
        imageModels: [{ engine: 'comfy', modelId: 'sdxl-base' }],
        videoModels: [],
      },
    });
    expect(await failureOf({ image: ROUTE, video: ROUTE }, [peer]))
      .toMatchObject({ code: 'MEDIA_PROVIDER_MODEL_NOT_ALLOWED' });
  });

  // Live capacity is deliberately NOT a save-time gate: a provider is routinely
  // asleep when its route is configured. The enqueue path re-checks it.
  it('saves a route to a peer that is currently offline with no capacity snapshot', async () => {
    const sleeping = peerWith({ status: 'offline', mediaProviderStatus: undefined });
    expect(await failureOf({ image: ROUTE }, [sleeping])).toBeNull();
  });

  it('saves a route to a peer whose last capacity probe went stale', async () => {
    const stale = peerWith({
      status: 'online',
      mediaProviderStatus: { state: 'stale', freshUntil: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(await failureOf({ image: ROUTE }, [stale])).toBeNull();
  });
});

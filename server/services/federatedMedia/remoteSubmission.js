/**
 * Route-side helper that turns "the user picked peer X" into the persisted
 * remote-job marker the queue's remote adapters run from.
 *
 * It exists so every call site enforces the same three things in the same
 * order — the peer is registered, the local user explicitly allowlisted this
 * peer/model, and the provider has fresh capacity — before a job is enqueued.
 * Skipping any of them is how an agent would end up routing arbitrary work to
 * an arbitrary peer, which the provider contract exists to prevent.
 *
 * The preflight is advisory: the provider re-checks authorization and capacity
 * on submit. Doing it here just keeps known-doomed work from being queued.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { FEDERATED_MEDIA_WIRE_VERSION } from '../../lib/federatedMediaWire.js';

/**
 * @param {object} args
 * @param {string} args.peerId - Registered peer the user selected.
 * @param {'audio'|'image'|'video'} args.kind
 * @param {object} args.request - Validated wire submission (carries engine/modelId).
 * @returns {Promise<{peer: object, capability: object, remoteMedia: object}>}
 */
export async function prepareRemoteMediaJob({ peerId, kind, request }) {
  // Imported lazily, not statically: the image/video generate routes reach this
  // module, and a static edge to the peer registry would drag it (and its
  // settings/DB dependencies) into every route suite's module graph — where a
  // partially-mocked fileUtils then fails to load it. Nothing here runs until a
  // caller actually names a provider peer.
  const [{ getPeers }, { resolveFederatedMediaProvider }] = await Promise.all([
    import('../instances.js'),
    import('../federatedMediaConsumer.js'),
  ]);
  const peers = await getPeers();
  const peer = peers.find((candidate) => candidate.id === peerId);
  if (!peer) {
    throw new ServerError('Selected media provider peer was not found', {
      status: 404,
      code: 'MEDIA_PROVIDER_PEER_NOT_FOUND',
    });
  }
  const { capability } = await resolveFederatedMediaProvider(peer, {
    kind,
    engine: request.engine,
    modelId: request.modelId,
  });
  return {
    peer,
    capability,
    remoteMedia: {
      wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
      peerId: peer.id,
      reconcile: false,
      cancelRequested: false,
      request,
    },
  };
}

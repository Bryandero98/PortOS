/**
 * One reading of "is this peer usable as a media provider right now?" (#4348).
 *
 * Two surfaces answer that question — the Instances peer card (which also
 * edits the per-kind allowlist) and the System Health capacity panel — and they
 * must not disagree: a card reading `ready` beside a panel reading `stale` is
 * worse than either alone. The state machine, its labels, and the remedy text
 * therefore live here rather than inside one component.
 *
 * The server stays authoritative. `assertFederatedMediaProviderSelection`
 * (server/services/federatedMediaConsumer.js) re-probes and fail-closes before
 * any job leaves this instance, so nothing here gates work — it only decides
 * what the user is shown.
 */

import { Film, Image, Music2 } from 'lucide-react';

// Wire v1 shipped audio-only, then grew image and video (#4348). Every surface
// iterates this table so a newly federated kind cannot appear on one screen and
// be missing from another.
export const FEDERATED_MEDIA_KINDS = Object.freeze([
  { kind: 'audio', label: 'audio', field: 'audioModels', Icon: Music2 },
  { kind: 'image', label: 'image', field: 'imageModels', Icon: Image },
  { kind: 'video', label: 'video', field: 'videoModels', Icon: Film },
]);

export const FEDERATED_MEDIA_STATE_META = Object.freeze({
  ready: { label: 'ready', tone: 'success' },
  busy: { label: 'busy', tone: 'warning' },
  stale: { label: 'stale', tone: 'warning' },
  unauthorized: { label: 'auth required', tone: 'warning' },
  unsupported: { label: 'older peer', tone: 'note' },
  disabled: { label: 'provider off', tone: 'note' },
  unavailable: { label: 'unavailable', tone: 'warning' },
  unreachable: { label: 'unreachable', tone: 'warning' },
  invalid: { label: 'invalid status', tone: 'warning' },
});

export const FEDERATED_MEDIA_STATE_HELP = Object.freeze({
  busy: 'The peer is reachable, but its shared media lane is currently at capacity.',
  stale: 'The last capacity snapshot expired. New remote work is blocked until a fresh probe succeeds.',
  unauthorized: 'Store this peer’s instance-password credential above and make sure this instance is registered there.',
  unsupported: 'This peer does not expose the federated-media wire-v1 status endpoint yet.',
  disabled: 'Enable federated media sharing on the peer under Settings → Sharing.',
  unavailable: 'The peer has no currently ready allowlisted media runtime/model.',
  unreachable: 'The media status request failed. New remote work remains blocked.',
  invalid: 'The peer returned a response that did not match the versioned media-provider contract.',
});

// Not a real provider state — the peer is opted in but no probe has landed yet.
// Kept distinct from `unavailable` so a first-run instance doesn't accuse a
// perfectly healthy peer of having nothing to offer.
const CHECKING = Object.freeze({ label: 'checking', tone: 'muted' });
const OFF = Object.freeze({ label: 'off', tone: 'note' });
const PEER_OFFLINE = Object.freeze({ label: 'peer offline', tone: 'warning' });
// One shared empty array rather than a fresh literal per call: callers memoize
// on `capabilities`, and a new identity every render would defeat that memo for
// exactly the peers that have nothing to recompute.
const NO_CAPABILITIES = Object.freeze([]);

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
// NUL separator, matching the server's own model key: a printable separator
// would let an engine name containing it collide with a different pair.
export const federatedMediaModelKey = ({ engine, modelId }) => `${engine}\u0000${modelId}`;
const listOf = (raw, field) => (Array.isArray(raw?.[field]) ? raw[field] : []);

/**
 * The peer's locally-stored provider config, with every kind's list present.
 * @returns {{raw: object, enabled: boolean, models: Record<string, object[]>}}
 */
export function peerMediaProviderConfig(peer) {
  const raw = isRecord(peer?.mediaProvider) ? peer.mediaProvider : {};
  const models = {};
  for (const { kind, field } of FEDERATED_MEDIA_KINDS) models[kind] = listOf(raw, field);
  return { raw, enabled: raw.enabled === true, models };
}

/**
 * Has the stored snapshot outlived the freshness window it was probed under?
 *
 * The probe records `freshUntil` from the provider's own `generatedAt +
 * staleAfterMs`, then the record sits on disk until the next peer poll. A
 * snapshot probed as `ready` therefore keeps reading `ready` long after the
 * server would refuse to submit against it, which is precisely the
 * "stale must not look available" rule the capacity contract is built on.
 * Re-deriving expiry at render time closes that gap without a second probe.
 */
function snapshotExpired(status, now) {
  const freshUntil = Date.parse(status?.freshUntil);
  return Number.isFinite(freshUntil) && freshUntil < now;
}

/**
 * Resolve one peer's media-provider readiness for display.
 *
 * @param {object} peer - a sanitized peer record from `GET /api/instances`
 * @param {{now?: number}} [options]
 * @returns {{configured: boolean, state: string|null, label: string, tone: string,
 *   help: string|null, queue: object|null, capabilities: object[], checkedAt: string|null,
 *   models: Record<string, object[]>, modelCount: number, kinds: string[]}}
 */
export function resolvePeerMediaReadiness(peer, { now = Date.now() } = {}) {
  const config = peerMediaProviderConfig(peer);
  const status = isRecord(peer?.mediaProviderStatus) ? peer.mediaProviderStatus : null;
  const snapshot = isRecord(status?.snapshot) ? status.snapshot : null;
  // An expired snapshot is stale whatever the probe concluded — including the
  // `ready` it concluded at probe time.
  const state = !status
    ? null
    : (snapshotExpired(status, now) ? 'stale' : status.state);
  const meta = !config.enabled
    ? OFF
    : peer?.status !== 'online'
      ? PEER_OFFLINE
      : (FEDERATED_MEDIA_STATE_META[state] || CHECKING);
  return {
    configured: config.enabled,
    state,
    label: meta.label,
    tone: meta.tone,
    // Remedy text belongs to the provider state, not to the peer being offline
    // — an offline peer's own row already says so.
    help: (config.enabled && state && state !== 'ready' && FEDERATED_MEDIA_STATE_HELP[state]) || null,
    queue: isRecord(snapshot?.queue) ? snapshot.queue : null,
    capabilities: Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : NO_CAPABILITIES,
    checkedAt: typeof status?.checkedAt === 'string' ? status.checkedAt : null,
    models: config.models,
    modelCount: FEDERATED_MEDIA_KINDS.reduce((sum, { kind }) => sum + config.models[kind].length, 0),
    kinds: FEDERATED_MEDIA_KINDS.filter(({ kind }) => config.models[kind].length > 0).map(({ kind }) => kind),
  };
}

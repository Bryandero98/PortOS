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

// Peer-level readings that outrank whatever the last probe concluded. None of
// them is a provider state from the wire; each carries its own remedy because
// the wire's `state` may legitimately be absent (or stale-but-`ready`) while
// one of these holds.
//
// PEER_DISABLED comes first for the same reason the server checks it first:
// `assertFederatedMediaProviderSelection` rejects a submission to a disabled
// peer with MEDIA_PROVIDER_PEER_DISABLED before it looks at anything else, so a
// peer whose connection is switched off must never read as `ready` here no
// matter how healthy its cached snapshot looks.
const PEER_DISABLED = Object.freeze({
  label: 'peer disabled',
  tone: 'warning',
  help: 'This peer connection is switched off. Re-enable it under Instances before routing work to it.',
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

// The states that assert currently-available capacity. Only these need a
// verifiable freshness window; `unreachable`, `disabled`, `unsupported`,
// `unauthorized`, `unavailable` and `invalid` legitimately carry none, because
// the probe never got a snapshot to date.
const CAPACITY_CLAIMING_STATES = new Set(['ready', 'busy']);

/**
 * The state a stored status has actually earned, which is not always the one it
 * records.
 *
 * The probe writes `freshUntil` from the provider's own `generatedAt +
 * staleAfterMs`, then the record sits on the peer until the next poll — so a
 * status probed as `ready` keeps saying `ready` long after the server would
 * refuse to submit against it. Re-deriving the verdict at render time closes
 * that gap without a second probe.
 *
 * The checks below the guard mirror, in order, the gates
 * `assertFederatedMediaProviderSelection` applies before it will submit, so
 * neither surface can advertise a peer the server would reject. They all fail
 * CLOSED: an absent or unparseable `freshUntil` makes `Date.parse` return NaN,
 * and reading NaN as "not expired" would advertise a provider with no
 * verifiable window at all — the fail-open version of the very bug this
 * function exists to fix.
 *
 * Only the shape is checked here, not the full wire schema: the server does the
 * authoritative validation, and duplicating it client-side would be a second
 * copy to keep in sync. The bar is that a claim of current capacity must have
 * something behind it.
 */
function verifiedState(status, now) {
  const state = status?.state;
  const freshUntil = Date.parse(status?.freshUntil);
  if (Number.isFinite(freshUntil) && freshUntil < now) return 'stale';
  // A failure state makes no capacity claim, so it needs nothing to back one.
  if (!CAPACITY_CLAIMING_STATES.has(state)) return state;
  if (!Number.isFinite(freshUntil)) return 'stale';
  if (!isRecord(status.snapshot)) return 'invalid';
  return state;
}

// Same rationale as NO_CAPABILITIES, for the queue summary's kind list.
const NO_KIND_SUMMARY = Object.freeze([]);
const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * The peer's queue block as a display summary, shared by both surfaces.
 *
 * `concurrency` and `byKind` reached the wire after v1 shipped (#4348), so an
 * older provider omits them and every segment here is independently optional —
 * a missing field is dropped rather than rendered as a zero, which would claim
 * an idle lane the peer never reported. `slots` stays first because it is the
 * one segment every provider has always sent.
 *
 * @param {object|null} queue - `snapshot.queue` from a probed peer
 * @returns {{slots: string|null, drain: string|null, kinds: string[]}}
 */
export function summarizePeerMediaQueue(queue) {
  if (!isRecord(queue)) return { slots: null, drain: null, kinds: NO_KIND_SUMMARY };
  const slots = isCount(queue.running) && isCount(queue.queued)
    && isCount(queue.totalActive) && isCount(queue.maxQueuedJobs)
    ? `${queue.running} running · ${queue.queued} queued · ${queue.totalActive}/${queue.maxQueuedJobs} slots`
    : null;
  // "How fast does that backlog drain?", which queue depth alone cannot answer:
  // two jobs ahead on a 1-wide lane is a very different wait from two on a
  // 10-wide one.
  const drain = Number.isInteger(queue.concurrency) && queue.concurrency > 0
    ? `${queue.concurrency} at a time`
    : null;
  // Only kinds actually occupying a lane. Listing three zeroes crowds out the
  // one number that matters, and the `slots` segment above already reports
  // whether anything is running at all.
  const byKind = isRecord(queue.byKind) ? queue.byKind : null;
  const kinds = byKind
    ? FEDERATED_MEDIA_KINDS
      .map(({ kind, label }) => {
        const entry = byKind[kind];
        if (!isRecord(entry)) return null;
        const running = isCount(entry.running) ? entry.running : 0;
        const queued = isCount(entry.queued) ? entry.queued : 0;
        if (running + queued === 0) return null;
        const parts = [];
        if (running > 0) parts.push(`${running} running`);
        if (queued > 0) parts.push(`${queued} queued`);
        return `${label} ${parts.join(', ')}`;
      })
      .filter(Boolean)
    : NO_KIND_SUMMARY;
  return { slots, drain, kinds: kinds.length > 0 ? kinds : NO_KIND_SUMMARY };
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
  // An unverifiable status does not get to keep whatever the probe concluded —
  // including the `ready` it concluded at probe time.
  const state = status ? verifiedState(status, now) : null;
  const meta = peer?.enabled === false
    ? PEER_DISABLED
    : !config.enabled
      ? OFF
      : peer?.status !== 'online'
        ? PEER_OFFLINE
        : (FEDERATED_MEDIA_STATE_META[state] || CHECKING);
  return {
    configured: config.enabled,
    state,
    label: meta.label,
    tone: meta.tone,
    // A peer-level reading carries its own remedy; otherwise the remedy belongs
    // to the provider state. An offline peer gets none — its own row says so.
    help: meta.help !== undefined
      ? meta.help
      : ((config.enabled && state && state !== 'ready' && FEDERATED_MEDIA_STATE_HELP[state]) || null),
    queue: isRecord(snapshot?.queue) ? snapshot.queue : null,
    capabilities: Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : NO_CAPABILITIES,
    checkedAt: typeof status?.checkedAt === 'string' ? status.checkedAt : null,
    models: config.models,
    modelCount: FEDERATED_MEDIA_KINDS.reduce((sum, { kind }) => sum + config.models[kind].length, 0),
    kinds: FEDERATED_MEDIA_KINDS.filter(({ kind }) => config.models[kind].length > 0).map(({ kind }) => kind),
  };
}

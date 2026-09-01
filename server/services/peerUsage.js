/**
 * Federated AI-usage metrics.
 *
 * PortOS installs are commonly several machines federated as sync peers, and
 * "how much AI did I burn?" is a question about the FLEET, not about whichever
 * box the user happens to have open. This service is the `usage` sync
 * category's store: each instance publishes a digest of its own
 * `data/usage.json` (aggregate counters only — see `buildUsageDigest`) and
 * keeps every peer's digest side by side under `data/peer-usage.json`.
 *
 * Two invariants make that safe to run continuously:
 *
 *  - **Never merged into local usage.** A peer's counters live in their own
 *    per-instance slot. Summing them into `usage.json` would double-count on
 *    the very next round trip (our snapshot would ship the inflated total back)
 *    and would corrupt this machine's own history irreversibly.
 *  - **Idempotent, per-instance LWW.** A digest is replaced whole, keyed by its
 *    origin instanceId and stamped with `capturedAt`. Re-applying the same
 *    snapshot is a no-op, and a node forwards what it knows about third
 *    instances, so a chain (A↔B↔C) converges without A and C ever talking.
 *
 * Privacy: the digest carries provider ids, model ids, token/session/message
 * counts, day+month buckets and an instance name. No prompts, no transcripts,
 * no record contents, no PII — see
 * `docs/decisions/2026-09-01-federated-usage-metrics.md`.
 */

import { join } from 'path';
import { atomicWrite, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { createMutex } from '../lib/asyncMutex.js';
import { compareNewerWins, parseTsMs } from '../lib/lwwTimestamp.js';
import { canonicalSnapshotChecksum } from '../lib/snapshotChecksum.js';
import { roundCents } from '../lib/subscriptionSavings.js';
import { buildUsageDigest, buildUsageReport, getUsage, USAGE_FILE } from './usage.js';

const PEER_USAGE_FILE = join(PATHS.data, 'peer-usage.json');

// Upper bound on stored peer digests. A home federation runs a handful of
// machines; the cap only stops an unbounded file if a peer ever forwards a long
// tail of instance ids that no longer exist. Oldest `capturedAt` is evicted.
const MAX_INSTANCES = 64;

const withLock = createMutex();

const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * This machine's federation identity. Dynamically imported so `dataSync` →
 * `peerUsage` doesn't drag `services/instances.js` (peer socket relay,
 * federated-media consumer, tailscale) into dataSync's module-load path — the
 * same reason dataSync defers `sharing/peerSync.js`.
 */
async function readSelfIdentity() {
  const { getSelf, UNKNOWN_INSTANCE_ID } = await import('./instances.js');
  const self = await getSelf().catch(() => null);
  const instanceId = isNonEmptyStr(self?.instanceId) && self.instanceId !== UNKNOWN_INSTANCE_ID
    ? self.instanceId
    : null;
  return { instanceId, name: isNonEmptyStr(self?.name) ? self.name : null };
}

async function readStore() {
  // Non-strict: this file is entirely derived, replicated state. A corrupt read
  // self-heals on the next sync cycle, which beats throwing on every poll.
  const raw = await readJSONFile(PEER_USAGE_FILE, null);
  const instances = isPlainObject(raw?.instances) ? raw.instances : {};
  return { instances };
}

/**
 * Coerce one wire entry into a stored entry, or null when it can't be trusted.
 * The digest itself is read defensively downstream (every field is optional to
 * `buildUsageReport`), so this only pins identity and orderability: the entry
 * must belong to the map key it arrived under, and carry a parseable stamp.
 */
function sanitizeEntry(entry, expectedId) {
  if (!isPlainObject(entry) || !isPlainObject(entry.usage)) return null;
  // A digest may omit its own id (the key is authoritative), but it may never
  // claim a DIFFERENT one — that would let a peer smuggle a digest in under our
  // id, or overwrite a third instance's slot.
  if (isNonEmptyStr(entry.instanceId) && entry.instanceId !== expectedId) return null;
  if (parseTsMs(entry.capturedAt) === null) return null;
  return {
    instanceId: expectedId,
    name: isNonEmptyStr(entry.name) ? entry.name.slice(0, 120) : expectedId,
    capturedAt: entry.capturedAt,
    usage: entry.usage,
  };
}

// The self digest is a pure function of (usage counters, today's date) — the
// date because the wire rollup's cutoff moves at midnight. `saveUsage` stamps
// `lastUpdated` on every write, so it doubles as the cache key. Without this
// memo the deep clone + rollup re-ran on every checksum-cache miss AND once per
// probing peer, all producing the identical byte-for-byte digest.
let digestMemo = null;
function selfDigest(usageData) {
  const key = `${usageData?.lastUpdated ?? ''}|${new Date().toISOString().slice(0, 10)}`;
  if (digestMemo?.key !== key) digestMemo = { key, digest: buildUsageDigest(usageData) };
  return digestMemo.digest;
}

/** This instance's own live entry, rebuilt from `usage.json` on every read. */
async function buildSelfEntry() {
  const { instanceId, name } = await readSelfIdentity();
  if (!instanceId) return null;
  const usage = selfDigest(getUsage());
  return { instanceId, name: name || instanceId, capturedAt: usage.lastUpdated, usage };
}

/**
 * Every instance we can report on: the peer digests we hold, plus our own live
 * entry. Our own slot is always regenerated — a stale copy of us that came back
 * from a peer never wins. A digest with no activity yet has a null
 * `lastUpdated` and is dropped from the wire rather than shipped unorderable.
 */
async function entriesWithSelf() {
  const [store, self] = await Promise.all([readStore(), buildSelfEntry()]);
  const peers = Object.values(store.instances).filter((e) => isPlainObject(e) && isPlainObject(e.usage));
  const publishable = self && isNonEmptyStr(self.capturedAt) ? self : null;
  return {
    self: publishable,
    peers: peers.filter((e) => e.instanceId !== self?.instanceId),
  };
}

/**
 * dataSync `getSnapshot` for the `usage` category: our own live digest plus
 * every peer digest we hold, so a third instance reachable only through us
 * still propagates.
 */
export async function getUsageSnapshot() {
  const { self, peers } = await entriesWithSelf();
  const instances = Object.fromEntries(peers.map((e) => [e.instanceId, e]));
  if (self) instances[self.instanceId] = self;
  const data = { instances };
  // CANONICAL: the payload is a map keyed by instance ids arriving over the
  // wire, so two converged peers would otherwise hash differently purely from
  // the order they happened to learn each other — which the sync UI reads as
  // "behind" forever.
  return { data, checksum: canonicalSnapshotChecksum(data) };
}

/**
 * dataSync `applyRemote` for the `usage` category. Per-instance LWW on
 * `capturedAt`; our own slot is skipped outright (we are the authority on our
 * own counters), and nothing is ever summed into `data/usage.json`.
 */
export async function applyUsageRemote(remoteData) {
  const incoming = isPlainObject(remoteData?.instances) ? remoteData.instances : null;
  if (!incoming) return { applied: false, count: 0 };

  const { instanceId: selfId } = await readSelfIdentity();

  return withLock(async () => {
    const store = await readStore();
    let changed = 0;

    for (const [key, rawEntry] of Object.entries(incoming)) {
      if (!isNonEmptyStr(key) || key === selfId) continue;
      const entry = sanitizeEntry(rawEntry, key);
      if (!entry) continue;
      if (!compareNewerWins(entry.capturedAt, store.instances[key]?.capturedAt)) continue;
      store.instances[key] = entry;
      changed++;
    }

    if (changed === 0) return { applied: false, count: 0 };

    const ids = Object.keys(store.instances);
    if (ids.length > MAX_INSTANCES) {
      const oldestFirst = ids.sort((a, b) => (parseTsMs(store.instances[a].capturedAt) ?? 0) - (parseTsMs(store.instances[b].capturedAt) ?? 0));
      for (const id of oldestFirst.slice(0, ids.length - MAX_INSTANCES)) delete store.instances[id];
    }

    await atomicWrite(PEER_USAGE_FILE, store);
    console.log(`🔄 Usage sync: updated ${changed} instance digest${changed === 1 ? '' : 's'}`);
    return { applied: true, count: changed };
  });
}

/**
 * Fleet-wide usage for a report window: one row per known instance plus the
 * combined totals.
 *
 * Every row goes through the SAME pure `buildUsageReport` the single-instance
 * page uses, so per-instance and fleet figures are priced identically — and
 * THIS machine's row reads the live activity maps, not its own wire digest. The
 * digest folds days past the wire-retention window into whole months, and
 * `buildUsageReport` includes a month bucket whole whenever its month overlaps
 * the window; routing our own row through it would make the "This machine" row
 * disagree with the headline directly above it on a narrow historical range.
 *
 * Peer rows are as fresh as the last sync, so `capturedAt` is surfaced for the
 * UI to age them rather than implying they are live.
 */
export async function getFleetUsage({ from = null, to = null, providers = [] } = {}) {
  const { self, peers } = await entriesWithSelf();
  if (peers.length === 0) return { instances: [], totals: null };

  const row = ({ instanceId, name, capturedAt, activity, isSelf }) => {
    const report = buildUsageReport(activity.dailyActivity || {}, {
      from,
      to,
      providers,
      monthlyActivity: activity.monthlyActivity || {},
      // Same rule as the single-instance summary: the all-time (unbounded)
      // window folds in legacy totals no bucket represents; a bounded window
      // must not, or it attributes all-time residue to the range.
      totalTokens: from || to ? null : activity.totalTokens,
    });
    return { instanceId, name: name || instanceId, self: isSelf, capturedAt, totals: report.totals };
  };

  const rows = peers.map((e) => row({ ...e, activity: e.usage, isSelf: false }));
  if (self) rows.unshift(row({ ...self, activity: getUsage(), isSelf: true }));

  rows.sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || b.totals.estimatedCost - a.totals.estimatedCost);

  // Derived from the report's own totals rather than a second hardcoded field
  // list, so a field added to `buildUsageReport` can't silently sum to zero here.
  const totals = rows.reduce((acc, r) => {
    for (const [field, value] of Object.entries(r.totals)) {
      if (typeof value === 'number') acc[field] = (acc[field] || 0) + value;
    }
    return acc;
  }, {});
  totals.estimatedCost = roundCents(totals.estimatedCost || 0);

  return { instances: rows, totals };
}

// Files whose fingerprint invalidates the category's checksum cache.
export const USAGE_CHECKSUM_PATHS = [USAGE_FILE, PEER_USAGE_FILE];

export { PEER_USAGE_FILE };

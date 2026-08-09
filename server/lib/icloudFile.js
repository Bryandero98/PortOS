/**
 * iCloud (ubiquity-container) file guards.
 *
 * ## Why this exists
 *
 * macOS "Optimize Mac Storage" evicts iCloud files to the cloud. An evicted
 * file is *dataless*: the path still exists and `stat()` still reports the real
 * `size`, but no blocks are allocated locally. The first `read(2)` against it
 * blocks in the kernel while the OS materializes the bytes — and if that
 * materialization stalls (wedged `bird` daemon, offline device), **the syscall
 * never returns and cannot be cancelled**.
 *
 * Node's async `fs` calls run on the libuv threadpool, which defaults to FOUR
 * threads. Four blocked reads therefore exhaust it, and from that moment every
 * `fs` operation in the process queues forever — including the `express.static`
 * stat/read that serves the client bundle. The observable symptom is "the whole
 * UI hangs" while memory-only routes still answer in milliseconds, which reads
 * like a network fault and is not one. Only a process restart clears it.
 *
 * Retry-on-error logic does NOT help here: a dataless read doesn't *fail*, it
 * *hangs*. The only safe move is to never issue the read in the first place.
 *
 * ## The screen
 *
 * `stat()` is safe — it does NOT trigger materialization and returns instantly
 * on a dataless file. Node exposes `Stats.blocks`, so a dataless file is
 * detectable with no native code and no subprocess: `size > 0 && blocks === 0`.
 *
 * The screen is deliberately scoped to darwin AND paths inside a ubiquity
 * container. An ordinary APFS file can also report `blocks === 0` when it is
 * transparently compressed (data lives in a `com.apple.decmpfs` xattr), so
 * applying the screen repo-wide could refuse to read a perfectly good file.
 * Inside `~/Library/Mobile Documents/` the two coincide in practice — macOS
 * represents "no local data" *via* the compression mechanism, which is why an
 * evicted file reports `compressed,dataless` together — and user JSON/markdown
 * in iCloud Drive is not otherwise compressed by the OS.
 *
 * If the screen ever did misfire, the cost is a degraded read (callers surface
 * "temporarily unavailable" and a background `brctl download` is kicked off,
 * after which the next read succeeds) — never a truncating write. Callers that
 * write keep their own refuse-to-overwrite guards.
 */

import { readFile, stat } from 'fs/promises';
import { spawn } from 'child_process';
import { bufferedSpawn } from './bufferedSpawn.js';

/** `err.code` on the rejection `readIfMaterialized` throws for an evicted file. */
export const ICLOUD_NOT_MATERIALIZED = 'ICLOUD_NOT_MATERIALIZED';

/** Every macOS app ubiquity container lives under this path segment. */
export const UBIQUITY_MARKER = '/Library/Mobile Documents/';

/** Default bound on an awaited `brctl download` (write paths only). */
export const DEFAULT_MATERIALIZE_TIMEOUT_MS = 20000;

/** True when `path` sits inside a macOS iCloud ubiquity container. */
export function isUbiquityPath(path) {
  return typeof path === 'string' && path.includes(UBIQUITY_MARKER);
}

/**
 * True when a `fs.Stats` looks dataless (evicted): a real byte length with zero
 * blocks allocated locally. Pure, so callers that already hold a `Stats` (e.g. a
 * status endpoint) can reuse it instead of paying a second `stat()`.
 */
export function isDatalessStats(stats) {
  return Boolean(stats) && stats.size > 0 && stats.blocks === 0;
}

/**
 * True when reading `path` would risk a permanently-blocked `read(2)`. Cheap:
 * one `stat()`, and only on darwin for ubiquity paths. A `stat()` failure
 * (ENOENT/EACCES) resolves `false` — absent and unreadable are the caller's
 * existing error paths, not this guard's business.
 */
export async function isSuspectedDataless(path) {
  if (process.platform !== 'darwin' || !isUbiquityPath(path)) return false;
  const stats = await stat(path).catch(() => null);
  return isDatalessStats(stats);
}

// `brctl` is present on every stock macOS. Warn at most once per process if it
// isn't (sandbox, stripped image) so operators aren't left wondering why
// materialization is a silent no-op, without spamming on every read.
let brctlMissingWarned = false;

/** Claim the one-shot "brctl is missing" warning. True on the first call only. */
export function markBrctlMissing() {
  if (brctlMissingWarned) return false;
  brctlMissingWarned = true;
  return true;
}

// Dedupe of in-flight background materializations, keyed by path, so repeated
// reads of the same evicted file don't spawn a `brctl` per request. Cleared when
// the child fails or exits non-zero so a later read can retry.
const pendingDownloads = new Set();

/**
 * Fire-and-forget `brctl download <path>` so an evicted file heals in the
 * background. Detached + unref'd so a slow download can't keep the process
 * alive at shutdown. Never throws and never blocks the caller — read paths use
 * this and then refuse the read for *this* cycle.
 */
export function requestMaterialization(path, label = 'iCloud file') {
  if (process.platform !== 'darwin' || !path) return false;
  if (pendingDownloads.has(path)) return false;
  pendingDownloads.add(path);

  // try/catch at a child-process boundary (permitted by the repo's no-try/catch
  // rule): `spawn` can throw synchronously on resource exhaustion (EMFILE), and
  // this runs inside a request's read path. A failed *heal* must never replace
  // the caller's ICLOUD_NOT_MATERIALIZED verdict with a spawn error — the read
  // is still correctly refused either way.
  let child;
  try {
    child = spawn('brctl', ['download', path], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    pendingDownloads.delete(path);
    console.warn(`⚠️ could not spawn brctl download for ${label}: ${err.message}`);
    return false;
  }
  // Capture `path` in each handler so a late exit from one child can't clear the
  // dedupe entry for a different path.
  child.on('error', (err) => {
    pendingDownloads.delete(path);
    if (err.code === 'ENOENT') {
      if (markBrctlMissing()) {
        console.warn(`⚠️ brctl not found on PATH; ${label} materialization disabled`);
      }
      return;
    }
    console.warn(`⚠️ brctl download failed for ${label}: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    pendingDownloads.delete(path);
    if (code === 0) {
      console.log(`📥 ${label} materialized from iCloud: ${path}`);
    } else if (code !== null) {
      console.warn(`⚠️ brctl download exited ${code} for ${label}: ${path}`);
    } else {
      console.warn(`⚠️ brctl download killed by ${signal} for ${label}: ${path}`);
    }
  });
  return true;
}

/**
 * Awaited `brctl download <path>`, bounded by `timeoutMs`. For **write** paths
 * that must know whether the bytes are local before deciding it's safe to
 * overwrite. Resolves `true` only on a clean exit-0; every failure mode
 * (non-darwin, missing brctl, spawn error, timeout, non-zero exit) resolves
 * `false` so the caller falls through to its own refuse-to-overwrite guard —
 * this can only improve the situation, never worsen it.
 *
 * Read paths must NOT use this: a wedged iCloud makes every read pay the full
 * timeout. They use `requestMaterialization` (background) instead.
 */
export async function materializeICloudFile(path, options = {}) {
  const { timeoutMs = DEFAULT_MATERIALIZE_TIMEOUT_MS, label = 'iCloud file' } = options;
  if (process.platform !== 'darwin' || !path) return false;
  const result = await bufferedSpawn('brctl', ['download', path], { timeoutMs, shell: false });
  if (result.success) return true;
  if (result.error?.code === 'ENOENT') {
    if (markBrctlMissing()) {
      console.warn(`⚠️ brctl not found on PATH; ${label} on-demand materialize disabled`);
    }
  } else if (result.timedOut) {
    console.warn(`⚠️ brctl download timed out after ${timeoutMs}ms for ${label}: ${path}`);
  } else if (result.error) {
    console.warn(`⚠️ brctl download failed for ${label}: ${result.error.message}`);
  } else {
    console.warn(`⚠️ brctl download exited ${result.code} for ${label}: ${path}`);
  }
  return false;
}

// Single-flight map so N concurrent callers for the same path share ONE
// underlying read and can occupy at most one threadpool slot between them.
// Entries are removed as soon as the read settles, so a later call re-reads
// (this coalesces concurrency, it does not cache content).
const inFlightReads = new Map();

/**
 * `readFile`, but never against an evicted iCloud file.
 *
 * - Materialized (or not an iCloud path at all): a plain `readFile`.
 * - Evicted: kicks a background `brctl download` and rejects with
 *   `err.code === ICLOUD_NOT_MATERIALIZED` — the read is never issued, so no
 *   threadpool slot can be stranded.
 *
 * Concurrent calls for the same path share one read.
 *
 * Residual risk, accepted and bounded: eviction can still land in the window
 * between the `stat()` screen and the `readFile`. Single-flight caps the damage
 * at one threadpool slot per path rather than one per caller, and
 * `UV_THREADPOOL_SIZE` is raised in `ecosystem.config.cjs` so a stranded slot
 * doesn't starve the process.
 */
export async function readIfMaterialized(path, options = {}) {
  const existing = inFlightReads.get(path);
  if (existing) return existing;
  const pending = guardedRead(path, options).finally(() => inFlightReads.delete(path));
  inFlightReads.set(path, pending);
  return pending;
}

async function guardedRead(path, options) {
  const { encoding = 'utf-8', label = 'iCloud file' } = options;
  if (await isSuspectedDataless(path)) {
    requestMaterialization(path, label);
    const err = new Error(`${label} is evicted from local storage (iCloud); refusing to block on read`);
    err.code = ICLOUD_NOT_MATERIALIZED;
    throw err;
  }
  return readFile(path, encoding);
}

/** Test hook: clear the one-shot warning + dedupe/single-flight state. */
export function _resetICloudFileStateForTest() {
  brctlMissingWarned = false;
  pendingDownloads.clear();
  inFlightReads.clear();
}

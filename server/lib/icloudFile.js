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
 * The screen is deliberately scoped to darwin AND paths that resolve into a
 * cloud-file root. An ordinary APFS file also reports `blocks === 0` when it is
 * sparse or transparently compressed (data in a `com.apple.decmpfs` xattr), and
 * other filesystems do the same for inline extents — so an unscoped screen would
 * refuse to read perfectly good files. Inside a cloud root the two coincide in
 * practice: macOS represents "no local data" *via* the compression mechanism,
 * which is why an evicted file reports `compressed,dataless` together, and user
 * JSON/markdown in iCloud Drive is not otherwise compressed by the OS.
 *
 * **Cost if the screen ever does misfire** (a genuinely sparse or compressed file
 * that lives inside a cloud root): reads of that file report "temporarily
 * unavailable" and `brctl download` cannot fix it, because the bytes were never
 * evicted — so it does NOT self-heal on the next read. Data is never lost: write
 * paths keep their own refuse-to-overwrite guards, so the failure mode is a
 * persistent read/write outage for that one file, not corruption. Callers that
 * must degrade gracefully (a vault walk) skip the file and report a skipped
 * count; callers that must not silently succeed (a store write) fail loudly.
 */

import { readFile, stat } from 'fs/promises';
import { realpathSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { createSingleFlight } from './singleFlight.js';

/** `err.code` on the rejection `readIfMaterialized` throws for an evicted file. */
export const ICLOUD_NOT_MATERIALIZED = 'ICLOUD_NOT_MATERIALIZED';

// macOS cloud-file roots whose contents can be evicted to the cloud and whose
// first `read(2)` therefore blocks: iCloud's per-app ubiquity containers, and the
// File Provider mounts macOS 12+ gives third parties (Dropbox / Google Drive /
// OneDrive "online-only"). `brctl` only heals the iCloud one — but *refusing* the
// read is what prevents the outage, so both are screened.
const CLOUD_MARKERS = ['/Library/Mobile Documents/', '/Library/CloudStorage/'];

// Only iCloud paths can be healed with `brctl download`.
const ICLOUD_MARKER = CLOUD_MARKERS[0];

// A literal substring test is not enough: `~/Documents` is a SYMLINK into
// `~/Library/Mobile Documents/com~apple~CloudDocs/Documents` when macOS
// "Desktop & Documents Folders" sync is on, so a vault stored as
// `/Users/x/Documents/Vault` is in iCloud while its path string says nothing of
// the sort. Resolving the real path is what closes that hole — but a `realpath`
// per read would tax every ordinary file read in the process, so resolve the
// containing DIRECTORY once and memoize it (a vault walk reads many files per
// directory). Bounded so a long-lived process can't grow it without limit; a
// symlink that is repointed after boot is not re-resolved until the entry is
// evicted, which is an acceptable trade for the cost saved.
const dirCloudCache = new Map();
const DIR_CACHE_MAX = 512;

function markerMatch(path) {
  return CLOUD_MARKERS.some(marker => path.includes(marker));
}

/**
 * True when `path` resolves into a macOS cloud-file root whose contents can be
 * evicted. Checks the literal string first (the common, allocation-free case),
 * then falls back to the memoized real path of the containing directory so a
 * symlinked route into iCloud (`~/Documents/...`) is still recognized.
 */
export function isUbiquityPath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (markerMatch(path)) return true;
  const dir = dirname(path);
  const cached = dirCloudCache.get(dir);
  if (cached !== undefined) return cached;
  // realpathSync throws for a missing/unreadable directory; a path we can't
  // resolve is not one we can claim is in the cloud.
  let resolved = false;
  try {
    resolved = markerMatch(realpathSync(dir));
  } catch {
    resolved = false;
  }
  if (dirCloudCache.size >= DIR_CACHE_MAX) dirCloudCache.clear();
  dirCloudCache.set(dir, resolved);
  return resolved;
}

/** True when `path` is an iCloud ubiquity path, the only kind `brctl` can heal. */
function isHealablePath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (path.includes(ICLOUD_MARKER)) return true;
  try {
    return realpathSync(dirname(path)).includes(ICLOUD_MARKER);
  } catch {
    return false;
  }
}

/**
 * True when a `fs.Stats` looks dataless (evicted): a real byte length with zero
 * blocks allocated locally.
 *
 * **Not sufficient on its own** — an ordinary APFS file reports `blocks === 0`
 * when it is sparse or transparently compressed, and other filesystems do the
 * same for inline/compressed extents. Always pair it with the platform + cloud-root
 * scoping (`isEvictedStats`, or `isSuspectedDataless` which does the `stat` too);
 * a bare call would refuse to read perfectly good files. Kept exported because a
 * caller that already holds a `Stats` should not pay a second `stat()`.
 */
export function isDatalessStats(stats) {
  return Boolean(stats) && stats.size > 0 && stats.blocks === 0;
}

/**
 * The correctly-scoped verdict for a caller that already holds a `Stats`:
 * dataless-looking AND on darwin AND inside a cloud-file root. Use this rather
 * than `isDatalessStats` alone.
 */
export function isEvictedStats(path, stats) {
  return process.platform === 'darwin' && isDatalessStats(stats) && isUbiquityPath(path);
}

/**
 * True when reading `path` would risk a permanently-blocked `read(2)`. Cheap:
 * one `stat()`, and only on darwin for cloud-root paths. A `stat()` failure
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

// Claim the one-shot "brctl is missing" warning. True on the first call only.
function markBrctlMissing() {
  if (brctlMissingWarned) return false;
  brctlMissingWarned = true;
  return true;
}

// In-flight background materializations, `path -> child`. The child doubles as an
// identity token: cleanup must only clear the entry it owns. A deadline kill frees
// the slot before that child's 'exit' fires, so a read arriving in between can
// legitimately start a REPLACEMENT for the same path — and the old child's late
// 'exit' must not then delete the replacement's entry, which would let the next
// read spawn a duplicate and break the concurrency cap.
const pendingDownloads = new Map();

// Hard cap on concurrent background downloads. Without it, a vault-wide walk over
// an evicted Obsidian vault (one read per note) would spawn one `brctl` child per
// note — thousands of processes for a large vault. Skipping the heal past the cap
// is safe: the read is refused either way, and the set drains as children exit so
// later reads pick up where this one stopped.
const MAX_PENDING_DOWNLOADS = 4;

// Every background download gets a deadline. `brctl` is exactly what hangs when
// iCloud is wedged — the very condition this module exists for — and without a
// deadline four hung children would hold all MAX_PENDING_DOWNLOADS slots for the
// life of the process, silently ending all healing and leaking the children.
// Exposed (not const) so tests don't wait on it.
export let DOWNLOAD_DEADLINE_MS = 120_000;
export function _setDownloadDeadlineForTest(ms) { DOWNLOAD_DEADLINE_MS = ms; }

/**
 * Fire-and-forget `brctl download <path>` so an evicted file heals in the
 * background. Detached + unref'd so a slow download can't keep the process
 * alive at shutdown. Never throws and never blocks the caller — read paths use
 * this and then refuse the read for *this* cycle.
 */
export function requestMaterialization(path, label = 'iCloud file') {
  if (process.platform !== 'darwin' || !path) return false;
  // `brctl` speaks iCloud only. A third-party File Provider file (Dropbox /
  // Google Drive / OneDrive under ~/Library/CloudStorage) is still screened and
  // refused above — we just can't heal it, so don't spawn a doomed child.
  if (!isHealablePath(path)) return false;
  if (pendingDownloads.has(path)) return false;
  if (pendingDownloads.size >= MAX_PENDING_DOWNLOADS) return false;

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
    // Nothing was reserved yet — the slot is claimed below, after a successful
    // spawn — so there is nothing to release here.
    console.warn(`⚠️ could not spawn brctl download for ${label}: ${err.message}`);
    return false;
  }
  // `spawn` is synchronous, so no other read can interleave between the size
  // check above and this reservation.
  pendingDownloads.set(path, child);
  // Release only the entry THIS child owns (see the map's comment above).
  const release = () => {
    if (pendingDownloads.get(path) === child) pendingDownloads.delete(path);
  };
  // Kill the child if it outlives its deadline, so a wedged `brctl` frees its slot
  // instead of holding it forever. `unref` so the timer itself never keeps the
  // process alive; the 'exit' handler below clears the slot once the kill lands.
  const deadline = setTimeout(() => {
    console.warn(`⚠️ brctl download exceeded ${DOWNLOAD_DEADLINE_MS}ms for ${label}; killing: ${path}`);
    // The child is detached (its own process group), so a bare kill would leave
    // any grandchildren behind — signal the group.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    // A killed-but-unreaped child would strand the slot; drop it now so healing
    // can resume even if 'exit' never fires.
    release();
  }, DOWNLOAD_DEADLINE_MS);
  deadline.unref?.();
  const settle = () => { clearTimeout(deadline); release(); };

  // Capture `path` in each handler so a late exit from one child can't clear the
  // dedupe entry for a different path.
  child.on('error', (err) => {
    settle();
    if (err.code === 'ENOENT') {
      if (markBrctlMissing()) {
        console.warn(`⚠️ brctl not found on PATH; ${label} materialization disabled`);
      }
      return;
    }
    console.warn(`⚠️ brctl download failed for ${label}: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    settle();
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

// N concurrent callers for the same path share ONE underlying read, so they
// occupy at most one threadpool slot between them. The shared coalescer clears
// each slot as soon as the read settles, so a later call re-reads — this
// coalesces concurrency, it does not cache content.
let readFlight = createSingleFlight();

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
  const { encoding = 'utf-8' } = options;
  // Key on encoding too: two concurrent callers asking for different encodings
  // must not share one result (a utf-8 string is not a base64 string).
  return readFlight.run(`${encoding}\u0000${path}`, () => guardedRead(path, options));
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
  readFlight = createSingleFlight();
  dirCloudCache.clear();
}

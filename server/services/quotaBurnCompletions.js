/**
 * The `run once` completion ledger — which burn jobs have already had their one
 * dispatch.
 *
 * A burn plan is an ordered ROTATION the runner walks lap after lap until a
 * quota gate closes. That is right for standing work ("audit accessibility",
 * "render the bible entries that still have no image") and wrong for one-shot
 * work ("write the missing setup doc"), which was simply re-done every lap for
 * as long as the window had quota left. A job marked `runOnce` in the plan
 * records itself here when it dispatches and drops out of the rotation until the
 * user re-arms it.
 *
 * One file, `data/cos/quota-burn-completions.json`: `<familyId>:<jobId>` → the
 * ISO instant it ran. Machine-local and deliberately NOT federated, like every
 * other quota-burn ledger — quota belongs to a particular machine and provider
 * account, and each machine's plan names its own managed apps.
 *
 * Why a ledger rather than a flag on the job: a config PUT replaces a family's
 * whole `jobs` array (that is how every reorder and edit saves), so an "already
 * ran" flag living on the job would be silently reset by an unrelated edit — and
 * by the client's optimistic copy of the plan, which never sees the runner's
 * write at all. The run log can't answer it either: it is a capped UI feed (50
 * entries), so a job that ran last month has already aged out of it.
 */

import { join } from 'path';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { QUOTA_BURN_BOUNDS, QUOTA_BURN_FAMILIES, quotaBurnJobKey } from '../lib/quotaBurnConfig.js';

const LEDGER_FILE = () => join(PATHS.cos, 'quota-burn-completions.json');

/**
 * Entries kept, newest first — twice the most keys a live plan can hold, so
 * pruning can only ever evict the record of a job that has since been deleted
 * from the plan, never a live one (which would put a spent job back into the
 * rotation behind the user's back). Without any bound the file would grow by one
 * dead key for every job the user ever adds and removes.
 *
 * DERIVED rather than written down: the margin is only real while it tracks the
 * family list and the per-family job cap, and a hardcoded 200 would silently
 * stop covering a live plan the moment either grew.
 */
const LEDGER_LIMIT = QUOTA_BURN_FAMILIES.length * QUOTA_BURN_BOUNDS.jobsPerFamily.max * 2;

// Single tail for the read-modify-write. The scheduler tick and a manual "Run
// now" can both finish a dispatch at once; unserialized, the second read would
// miss the first's write and lose a completion — putting a one-shot job back in
// the rotation. The "serialize two write paths that mutate the same record"
// case, not a defense against competing users.
const writeQueue = createFileWriteQueue();

/**
 * `<familyId>:<jobId>` → ISO instant of the dispatch that spent the job, or
 * `null` when the ledger could not be read.
 *
 * The `null` is load-bearing, and is why this reads STRICTLY (the same posture
 * as `quotaBurnDenials.js`). A failed or corrupt read must not come back as
 * "nothing has run": that re-dispatches every one-shot job on the plan, and the
 * next write then persists that empty ledger over the completions that survived.
 * Callers turn it into a skipped cycle, not a burn.
 */
export async function getQuotaBurnCompletions() {
  const { ok, value } = await readJSONFileStrict(LEDGER_FILE(), {}, { logError: false });
  if (!ok) return null;
  if (!isPlainObject(value)) return {};
  // A hand-edited or half-written entry must not put a truthy non-instant in
  // front of `jobIsSpent`, which would retire that job forever.
  return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === 'string' && at));
}

// Newest first, then capped — `Date.parse` on an unparseable value yields NaN,
// which sorts last and is dropped first, which is the right end for a value we
// can't date.
const prune = (ledger) => Object.fromEntries(
  Object.entries(ledger)
    .sort(([, a], [, b]) => (Date.parse(b) || 0) - (Date.parse(a) || 0))
    .slice(0, LEDGER_LIMIT),
);

/**
 * Read-modify-write inside the queue. `mutate` returns the next ledger, or
 * `null` for "nothing to change" — which skips the write, so re-arming a family
 * that never ran anything costs one read rather than a pointless rewrite.
 * Mirrors `quotaBurnDenials.js#writeLedger`, including the guard that is the
 * whole point: never overwrite a ledger we could not read.
 */
const writeLedger = (mutate) => writeQueue(async () => {
  const ledger = await getQuotaBurnCompletions();
  if (!ledger) return null;
  const next = mutate({ ...ledger });
  if (!next) return null;
  await atomicWrite(LEDGER_FILE(), next);
  return next;
});

/**
 * Mark one job as having had its run. Idempotent on the key and re-stamps the
 * instant, so a forced re-run of an already-spent job reports the latest time.
 */
export async function recordQuotaBurnJobCompletion(familyId, jobId, { now = Date.now() } = {}) {
  if (!familyId || !jobId) return null;
  return writeLedger((ledger) => prune({ ...ledger, [quotaBurnJobKey(familyId, jobId)]: new Date(now).toISOString() }));
}

/**
 * Re-arm: put a spent `run once` job back into the rotation. Omitting `jobId`
 * re-arms the family's whole plan, which is how "run that series again" is
 * expressed — the alternative is clicking through every step of a plan the user
 * configured as a series in the first place.
 */
export async function clearQuotaBurnJobCompletion(familyId, jobId = null) {
  if (!familyId) return null;
  return writeLedger((ledger) => {
    const keys = Object.keys(ledger).filter((key) => (jobId
      ? key === quotaBurnJobKey(familyId, jobId)
      : key.split(':')[0] === familyId));
    if (!keys.length) return null;
    for (const key of keys) delete ledger[key];
    return ledger;
  });
}

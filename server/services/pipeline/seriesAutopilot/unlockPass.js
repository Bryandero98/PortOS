/**
 * Series Autopilot — "unlock everything this series owns" pre-pass.
 *
 * Opt-in via the `unlockForRun` run option. A user who wants the autopilot to
 * act on the editorial findings END-TO-END (rewrite the arc, re-cut volumes,
 * re-describe a character the checks flagged as thin) otherwise has to hunt
 * down every lock toggle by hand first — a locked arc/season/stage/canon entry
 * makes the corresponding fix path throw or silently skip, and the run pauses
 * on findings it was never allowed to resolve. This pass clears those locks
 * once, at the top of the run.
 *
 * TWO HARD BOUNDARIES — both are the point of the feature, not incidental:
 *
 * 1. SERIES SCOPE. Universe canon (characters / places / objects) and the
 *    universe's own world fields are shared across every series linked to that
 *    universe, so a blanket unlock would hand the autopilot edit rights over
 *    another series' cast and setting. Canon is filtered by ownership
 *    (`isSeriesScopedCanonEntry`, which owns the `sourceSeriesId` rule); the
 *    universe's world-field locks have no per-series ownership at all, so they
 *    are cleared ONLY when this series is the universe's sole series.
 *    Everything else the pass touches (arc, arc fields, seasons, issue stages)
 *    is wholly series-owned, so it unlocks unconditionally.
 *
 * 2. NEVER DESTRUCTIVE. The pass only clears `locked` bits — it never removes a
 *    canon entry, a season, an issue or a catalog ingredient. Unlocking is what
 *    lets the autopilot FULLY EDIT a character or object in the story; the
 *    entry itself stays in the Universe (and its projected Catalog ingredient
 *    stays in the Catalog) regardless. If a record ever needs to leave, that is
 *    a catalog ARCHIVE (soft-delete/tombstone), performed by a human — the
 *    autopilot has no canon/catalog deletion path and must not grow one here.
 *    Season records get the same treatment: see `preserveDroppedSeasons` in
 *    `arcPlanner/arcCore.js#commitSeasonsWithRemap`, which the autopilot sets
 *    on every arc-rewriting call once this pass has run, so a regenerated arc
 *    can rewrite a volume's content but can never make the volume vanish (the
 *    per-season lock used to be the only thing preventing that).
 *
 * Locks are NOT restored when the run ends. The user opted into an unlocked
 * series; silently re-freezing records the autopilot just rewrote would leave
 * the lock state lying about what is user-frozen. The pass reports exactly what
 * it changed (SSE frame + log) so re-locking is an informed choice.
 */

import { BIBLE_KEYS, isSeriesScopedCanonEntry } from '../../../lib/storyBible.js';
import { getUniverse } from '../../universeBuilder.js';
import { setCanonLocksForSeries } from '../../universeCanon.js';
import { getSeries, updateSeries, listSeries } from '../series.js';
import { listIssues, updateStagesWithLatest, STAGE_IDS } from '../issues.js';
import { broadcast } from './session.js';

// THE definition of "which of this issue's stages are frozen". Both the
// dry-run's promised count and the sweep that actually clears them read it, so
// they cannot enumerate different stage sets (walking `Object.values(stages)`
// on one side and `STAGE_IDS` on the other would let a stage key outside
// STAGE_IDS be promised and never cleared).
const lockedStageIds = (issue) => STAGE_IDS.filter((id) => issue?.stages?.[id]?.locked === true);

// Every lock on the SERIES records this pass would clear, split by scope: the
// arc freeze, each per-field arc lock, each volume lock, each issue stage lock.
// ONE definition, consumed by both the dry-run plan (as a total) and the pass
// itself (as the per-scope counts it reports) — so a new lock surface can't be
// counted in one place and cleared in the other. Universe-side locks are
// deliberately excluded: they live on another record that only an async read
// could reach, and the dry-run plan is synchronous.
//
// `=== true` throughout: the sanitizer only persists `true`, but an unsanitized
// record must not make the promise and the report disagree.
export function seriesLockBreakdown(series, issues) {
  const locked = series?.locked || {};
  return {
    arc: locked.arc === true ? 1 : 0,
    arcFields: Object.values(locked.arcFields || {}).filter((v) => v === true).length,
    seasons: (Array.isArray(series?.seasons) ? series.seasons : []).filter((s) => s?.locked === true).length,
    stages: (Array.isArray(issues) ? issues : []).reduce((n, issue) => n + lockedStageIds(issue).length, 0),
  };
}

export const countSeriesLocks = (series, issues) =>
  Object.values(seriesLockBreakdown(series, issues)).reduce((a, b) => a + b, 0);

// Clear `series.locked` (the binary arc freeze + every per-field arc lock) AND
// every volume's lock in ONE patch. `updateSeries` applies `locked` and
// `seasons` as independent wholesale replaces over the freshest record inside
// its write queue, so a single call costs one read/write/peer-emit instead of
// two — and there is no re-read window between them.
async function unlockSeriesRecord(series) {
  const { arc, arcFields, seasons: lockedSeasons } = seriesLockBreakdown(series, null);
  if (arc === 0 && arcFields === 0 && lockedSeasons === 0) return { arc: 0, arcFields: 0, seasons: 0 };
  const seasons = Array.isArray(series.seasons) ? series.seasons : [];
  await updateSeries(series.id, {
    ...(arc || arcFields ? { locked: {} } : {}),
    ...(lockedSeasons ? { seasons: seasons.map((s) => (s?.locked === true ? { ...s, locked: false } : s)) } : {}),
  });
  return { arc, arcFields, seasons: lockedSeasons };
}

// Clear `locked` on every stage of every issue in the series. Batched through
// updateStagesWithLatest so the whole sweep is a single serialized write.
async function unlockIssueStages(seriesId, issues) {
  const updates = issues.flatMap((issue) => lockedStageIds(issue).map((stageId) => ({
    issueId: issue.id,
    stageId,
    // computeFn re-reads the freshest stage inside the write queue — a stage
    // unlocked between our read and the write yields `{}` (a no-op).
    computeFn: (cur) => (cur?.locked === true ? { locked: false } : {}),
  })));
  if (updates.length === 0) return 0;
  await updateStagesWithLatest(seriesId, updates);
  return updates.length;
}

// Nothing to unlock on the universe side. Named so the two paths that return it
// (no universe linked / the universe read failed) can't drift into reporting
// different key sets on an SSE frame the client reads field by field.
const NO_UNIVERSE_UNLOCKS = Object.freeze({ canon: 0, canonForeignKept: 0, worldFields: 0, worldFieldsKept: 0 });

// Is this series the ONLY one linked to `universeId`? EVERY universe-side
// unlock is gated on this (see `isSeriesScopedCanonEntry`), so it decides
// whether shared records get unfrozen — and it therefore FAILS CLOSED. A
// `listSeries()` that throws on a storage/DB read error must never be read as
// "no siblings found": `[]` would report sole-series and hand the pass
// permission to clear locks on canon a sibling series depends on. Uncertain
// linkage returns false — the run just keeps those locks, which is the
// recoverable direction. `listSeries()` loads every series in the install, so
// callers gate it on there actually being a locked record to decide about.
async function isSoleSeriesOfUniverse(seriesId, universeId) {
  const all = await listSeries().catch((err) => {
    console.log(`⚠️ autopilot unlock: could not list series to prove sole-universe ownership (${err.message}) — keeping universe-side locks`);
    return null;
  });
  if (!Array.isArray(all)) return false;
  return !all.some((s) => s.id !== seriesId && s.universeId === universeId);
}

// Does the universe hold ANY locked canon entry? Only then is the install-wide
// sole-series read worth paying for — with no locked canon and no locked world
// field there is nothing for `soleSeries` to decide.
const hasLockedCanon = (universe) => BIBLE_KEYS.some((key) =>
  (Array.isArray(universe?.[key]) ? universe[key] : []).some((e) => e?.locked === true));

// Clear the locks on the universe-side records this series owns: its canon
// entries, plus the universe's own world fields (logline / premise / styleNotes
// / influence lists). Those world fields are worth covering because the
// foundation gate's world + craft fixes report "every refinable world field is
// locked" and pause the run — exactly the stall this option exists to remove.
//
// BOTH are gated on this series being the universe's only one, and both live on
// the universe record, so they go out as ONE write: a second updateUniverse
// would re-read and re-sanitize the whole record and emit a second peer-sync
// `recordUpdated` for one user action.
async function unlockUniverseFor(seriesId, universeId) {
  const universe = await getUniverse(universeId).catch(() => null);
  if (!universe) return NO_UNIVERSE_UNLOCKS;
  const worldLocked = Object.values(universe.locked || {}).filter((v) => v === true).length;
  // One install-wide read at most, and only when a locked record's fate
  // actually depends on the answer.
  const soleSeries = (worldLocked > 0 || hasLockedCanon(universe))
    && await isSoleSeriesOfUniverse(seriesId, universeId);
  const canon = await setCanonLocksForSeries(universeId, seriesId, false, {
    soleSeries,
    clearWorldLocks: worldLocked > 0 && soleSeries,
  });
  return {
    canon: canon.changed,
    canonForeignKept: canon.foreignKept,
    worldFields: soleSeries ? worldLocked : 0,
    worldFieldsKept: soleSeries ? 0 : worldLocked,
  };
}

/**
 * Run the unlock pass for a series. Returns the per-scope counts plus a
 * `failures[]` of the scopes that threw (both ride the `unlock:applied` SSE
 * frame). Idempotent — a second run finds nothing locked and writes nothing.
 *
 * The three scopes are SEPARATELY settled, not `Promise.all`-ed. They write to
 * three independent stores, so one rejecting does NOT undo the two that already
 * committed — and a rejection that propagated out of here would make the step
 * handler report "locked records stay frozen" while some locks were in fact
 * permanently cleared. The run would then continue with mixed protection and no
 * frame naming what actually changed. Each scope reports its own outcome
 * instead, so the report always matches the disk.
 */
export async function unlockSeriesForAutopilot(seriesId) {
  const [series, issues] = await Promise.all([getSeries(seriesId), listIssues({ seriesId })]);
  // Three independent stores (series / issues / universe), so run them
  // concurrently rather than paying three sequential round-trips at the top of
  // every unlock-enabled run.
  const [record, stages, universe] = await Promise.allSettled([
    unlockSeriesRecord(series),
    unlockIssueStages(seriesId, issues),
    series.universeId
      ? unlockUniverseFor(seriesId, series.universeId)
      : Promise.resolve(NO_UNIVERSE_UNLOCKS),
  ]);
  const failures = [];
  const settled = (result, scope, zero) => {
    if (result.status === 'fulfilled') return result.value;
    failures.push(`${scope} (${result.reason?.message || 'unknown error'})`);
    return zero;
  };
  return {
    ...settled(record, 'series record', { arc: 0, arcFields: 0, seasons: 0 }),
    stages: settled(stages, 'issue stages', 0),
    ...settled(universe, 'universe canon', NO_UNIVERSE_UNLOCKS),
    failures,
  };
}

/**
 * Autopilot step handler. Unlocks the series, marks the run state so the
 * resolver routes past this step, and reports what changed. Never pauses — an
 * unlock failure is not worth stopping a run over, but it IS surfaced as a note
 * so the user knows which locks are still in place.
 */
export async function runUnlockPass(seriesId, record) {
  record.runState.locksUnlocked = true;
  const counts = await unlockSeriesForAutopilot(seriesId).catch((err) => {
    // Only the pre-read (series / issues) can land here — the three write
    // scopes settle individually above — so nothing was cleared.
    broadcast(seriesId, { type: 'note', message: `Could not unlock series records: ${err.message} — locked records stay frozen for this run.` });
    console.log(`⚠️ autopilot: unlock pass failed for ${seriesId.slice(0, 12)}: ${err.message}`);
    return null;
  });
  if (!counts) return {};
  broadcast(seriesId, { type: 'unlock:applied', ...counts });
  if (counts.failures.length) {
    broadcast(seriesId, { type: 'note', message: `Unlock was partial — ${counts.failures.join('; ')} failed, so those records stay frozen for this run.` });
  }
  console.log(`🔓 autopilot unlock — series=${seriesId.slice(0, 12)} arc=${counts.arc} arcFields=${counts.arcFields} seasons=${counts.seasons} stages=${counts.stages} canon=${counts.canon} world=${counts.worldFields} foreignKept=${counts.canonForeignKept} failed=${counts.failures.length}`);
  return {};
}

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
 * 1. SERIES SCOPE. Universe canon (characters / places / objects) is shared
 *    across every series linked to that universe, so a blanket unlock would
 *    hand the autopilot edit rights over another series' cast. An entry is
 *    unlocked only when it is provably THIS series' to edit:
 *      - `sourceSeriesId === seriesId`  → this series minted it. Unlock.
 *      - `sourceSeriesId` names another series → foreign. Stays locked.
 *      - no `sourceSeriesId` at all → unlock ONLY when this series is the sole
 *        series linked to the universe (nothing else can be affected).
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
 *    on its arc-rewriting calls whenever this pass has run, so a regenerated
 *    arc can rewrite a volume's content but can never make the volume vanish
 *    (the per-season lock used to be the only thing preventing that).
 *
 * Locks are NOT restored when the run ends. The user opted into an unlocked
 * series; silently re-freezing records the autopilot just rewrote would leave
 * the lock state lying about what is user-frozen. The pass reports exactly what
 * it changed (SSE frame + run marker) so re-locking is an informed choice.
 */

import { BIBLE_KEYS } from '../../../lib/storyBible.js';
import { getUniverse, updateUniverse } from '../../universeBuilder.js';
import { getSeries, updateSeries, listSeries } from '../series.js';
import { listIssues, updateStagesWithLatest, STAGE_IDS } from '../issues.js';
import { broadcast } from './session.js';

/**
 * PURE: is this universe-canon entry this series' to unlock?
 *
 * `soleSeries` is true when `seriesId` is the ONLY series linked to the
 * universe — the case where an unowned (legacy / universe-authored) entry has
 * no other series association to damage.
 */
export function isSeriesScopedCanonEntry(entry, { seriesId, soleSeries = false } = {}) {
  if (!entry || typeof entry !== 'object') return false;
  const owner = typeof entry.sourceSeriesId === 'string' ? entry.sourceSeriesId : '';
  if (owner) return owner === seriesId;
  return soleSeries === true;
}

/**
 * PURE: split a canon list into the locked entries this series may unlock and
 * the locked entries that must stay frozen (owned by, or shared with, another
 * series). Unlocked entries are ignored by both buckets — nothing to do.
 */
export function partitionLockedCanon(list, scope) {
  const unlockable = [];
  const foreign = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry?.locked !== true) continue;
    if (isSeriesScopedCanonEntry(entry, scope)) unlockable.push(entry);
    else foreign.push(entry);
  }
  return { unlockable, foreign };
}

// Clear `series.locked` (the binary arc freeze + every per-field arc lock).
// `locked: {}` is a wholesale replace in updateSeries, so this drops both.
async function unlockSeriesArc(seriesId, series) {
  const locked = series.locked || {};
  const arcLocked = locked.arc === true ? 1 : 0;
  const arcFieldsLocked = Object.keys(locked.arcFields || {}).length;
  if (arcLocked === 0 && arcFieldsLocked === 0) return { arc: 0, arcFields: 0 };
  await updateSeries(seriesId, { locked: {} });
  return { arc: arcLocked, arcFields: arcFieldsLocked };
}

// Clear every season's `locked`. Written as ONE series patch rather than N
// `updateSeason` calls: updateSeason refuses a content patch on a locked season
// and re-derives issue numbers per call, neither of which we want N times.
async function unlockSeasons(seriesId, series) {
  const seasons = Array.isArray(series.seasons) ? series.seasons : [];
  const lockedCount = seasons.filter((s) => s?.locked === true).length;
  if (lockedCount === 0) return 0;
  await updateSeries(seriesId, { seasons: seasons.map((s) => (s?.locked === true ? { ...s, locked: false } : s)) });
  return lockedCount;
}

// Clear `locked` on every stage of every issue in the series. Batched through
// updateStagesWithLatest so the whole sweep is a single serialized write.
async function unlockIssueStages(seriesId, issues) {
  const updates = [];
  for (const issue of issues) {
    for (const stageId of STAGE_IDS) {
      if (issue?.stages?.[stageId]?.locked !== true) continue;
      // computeFn re-reads the freshest stage inside the write queue — a stage
      // unlocked between our read and the write yields `{}` (a no-op).
      updates.push({
        issueId: issue.id,
        stageId,
        computeFn: (cur) => (cur?.locked === true ? { locked: false } : {}),
      });
    }
  }
  if (updates.length === 0) return 0;
  await updateStagesWithLatest(seriesId, updates);
  return updates.length;
}

// Clear `locked` on the series-scoped canon entries of the linked universe.
// Foreign entries (another series' cast, or shared entries in a multi-series
// universe) are counted and reported but left frozen — see boundary 1.
async function unlockSeriesCanon(seriesId, series) {
  if (!series.universeId) return { unlocked: 0, foreign: 0, universeId: null };
  const universe = await getUniverse(series.universeId).catch(() => null);
  if (!universe) return { unlocked: 0, foreign: 0, universeId: null };
  // "Sole series" decides whether an UNOWNED entry (no sourceSeriesId) is safe
  // to unlock. Deleted series don't count — listSeries already excludes them.
  const siblings = await listSeries().catch(() => []);
  const soleSeries = !siblings.some((s) => s.id !== seriesId && s.universeId === series.universeId);
  const scope = { seriesId, soleSeries };

  let unlocked = 0;
  let foreign = 0;
  // Mutator form so the patch is built from the freshest persisted canon inside
  // updateUniverse's write queue — a read-modify-write split would replace the
  // whole array from a stale read and clobber a concurrent render-completion
  // `imageRefs[]` append (the same reason setCanonKindLockAll uses it).
  await updateUniverse(series.universeId, (cur) => {
    unlocked = 0;
    foreign = 0;
    const patch = {};
    for (const key of BIBLE_KEYS) {
      const list = Array.isArray(cur[key]) ? cur[key] : null;
      if (!list) continue;
      const { unlockable, foreign: frozen } = partitionLockedCanon(list, scope);
      foreign += frozen.length;
      if (unlockable.length === 0) continue;
      const unlockIds = new Set(unlockable.map((e) => e.id));
      unlocked += unlockable.length;
      patch[key] = list.map((e) => (unlockIds.has(e.id) ? { ...e, locked: false } : e));
    }
    return Object.keys(patch).length > 0 ? patch : null;
  });
  return { unlocked, foreign, universeId: series.universeId };
}

/**
 * Run the unlock pass for a series. Returns the per-scope counts (also
 * broadcast as an `unlock:applied` SSE frame by the dispatch step). Idempotent
 * — a second run finds nothing locked and writes nothing.
 */
export async function unlockSeriesForAutopilot(seriesId) {
  const series = await getSeries(seriesId);
  const issues = await listIssues({ seriesId });
  const arcResult = await unlockSeriesArc(seriesId, series);
  // Re-read: unlockSeriesArc may have rewritten the record, and unlockSeasons
  // patches the whole `seasons` array (a stale copy would resurrect the locks
  // the arc patch just cleared alongside it).
  const seasons = await unlockSeasons(seriesId, await getSeries(seriesId));
  const stages = await unlockIssueStages(seriesId, issues);
  const canon = await unlockSeriesCanon(seriesId, series);
  return {
    arc: arcResult.arc,
    arcFields: arcResult.arcFields,
    seasons,
    stages,
    canon: canon.unlocked,
    canonForeignKept: canon.foreign,
    universeId: canon.universeId,
  };
}

/**
 * Autopilot step handler. Unlocks the series, marks the run state so the
 * resolver routes past this step, and reports what changed. Never pauses — an
 * unlock failure is not worth stopping a run over, but it IS surfaced as a note
 * so the user knows the locks are still in place.
 */
export async function runUnlockPass(seriesId, record) {
  record.runState.locksUnlocked = true;
  const counts = await unlockSeriesForAutopilot(seriesId).catch((err) => {
    broadcast(seriesId, { type: 'note', message: `Could not unlock series records: ${err.message} — locked records stay frozen for this run.` });
    console.log(`⚠️ autopilot: unlock pass failed for ${seriesId.slice(0, 12)}: ${err.message}`);
    return null;
  });
  if (!counts) return {};
  // `unlockedAny` drives the UI copy: a run on an already-unlocked series should
  // read as a no-op, not as "unlocked 0 things".
  const unlockedAny = counts.arc + counts.arcFields + counts.seasons + counts.stages + counts.canon > 0;
  broadcast(seriesId, { type: 'unlock:applied', ...counts, unlockedAny });
  console.log(`🔓 autopilot unlock — series=${seriesId.slice(0, 12)} arc=${counts.arc} arcFields=${counts.arcFields} seasons=${counts.seasons} stages=${counts.stages} canon=${counts.canon} foreignKept=${counts.canonForeignKept}`);
  return {};
}

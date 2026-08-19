/**
 * Registration stub for the Creative Director project → Creative Commission
 * back-pointer (`project.commissionId`).
 *
 * Why the field exists: a commission fire used to SNAPSHOT the commission's LLM
 * pin onto the project it minted (`modelOverrides.{treatment,plan}`). That froze
 * the provider for the life of the project — switch the commission from one agent
 * harness to another and a project already in flight kept handing its planner
 * task to the old one, forever, because the orphan sweep
 * (`cos.js#resetOrphanedTasks`, boot AND every 15 minutes) respawns the stale
 * task verbatim. And because nothing linked a project back to its commission,
 * pausing or deleting the commission cancelled only the CRON: the work already
 * spawned kept retrying with no way to stop it.
 *
 * The pin is now resolved LIVE at dispatch from this id
 * (`creativeCommissions/projectControl.js#commissionStagePin`, consumed by
 * `creativeDirector/agentBridge.js`), and the same id is how pause/delete finds
 * the projects to stop.
 *
 * Nothing to do in the file runner:
 *
 *   1. **No DDL.** The field lives inside the existing `creative_director_projects`
 *      `data` JSONB column and round-trips verbatim through
 *      `sanitizeProjectForSync` / `mergeProjectRecord`, so there is no column to
 *      add and no `PORTOS_SCHEMA_VERSIONS` bump (purely additive — an older peer
 *      preserves the key it doesn't understand).
 *
 *   2. **The backfill needs the DB pool.** This runner executes BEFORE the pool is
 *      initialized (the same reason migrations 048–052, 108, 160–162, 176, 178,
 *      and 194 are boot-time + stub-registered), so stamping `commissionId` onto
 *      projects minted before the field existed runs at boot instead:
 *      `backfillProjectCommissionIds()` in `services/creativeCommissions/projectControl.js`,
 *      invoked from `bootstrapSequence.js#armCommissionScheduler` just before the
 *      crons arm. It reads each commission's run ledger, is pure data movement
 *      (no LLM call), and is idempotent — a project that already carries the
 *      back-pointer is skipped, so a re-run writes nothing.
 *
 * Recovery is best-effort by construction: the run ledger is capped at
 * MAX_PERSISTED_RUNS, so a project evicted from it stays unlinked. Nothing else
 * can recover that association, and the next fire mints a correctly-stamped
 * project — an unlinked one keeps exactly its pre-change behavior.
 *
 * This stub exists so the change lands in `data/migrations.applied.json` and the
 * migration ledger records when the back-pointer began shipping.
 */

export default {
  async up() {
    console.log('🎯 CD project commissionId: additive JSONB field (no DDL); the ledger backfill runs at boot via backfillProjectCommissionIds — nothing to do in the file runner');
  },
};

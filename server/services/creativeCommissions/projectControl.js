/**
 * Creative Commission → Creative Director project control.
 *
 * A commission fire mints a CD project and the advance loop drives it from
 * there. Two things the commission must still be able to do to that work, and
 * the seam both run on:
 *
 *   - **Stop it.** Pausing or deleting a commission used to cancel only the CRON.
 *     The projects already spawned kept re-dispatching their cognitive stages,
 *     and the orphan sweeps (boot + the 15-minute health check in cos.js) kept
 *     respawning the agent tasks behind them — so a commission with a bad brief
 *     could not actually be stopped. `stopCommissionProjects` runs the CD hard
 *     stop over everything the commission spawned.
 *
 *   - **Re-provider it.** The commission's LLM pin is resolved at DISPATCH time
 *     (agentBridge → `commissionStagePin` below), so an edit reaches every
 *     not-yet-dispatched stage with no write and no sweep. The one thing a live
 *     read cannot fix is a task ALREADY handed to the runner: its provider is
 *     frozen in the task's own metadata, and the orphan sweep respawns it
 *     verbatim. `restartCommissionStages` retires exactly those.
 *
 * The link is `project.commissionId`, stamped at fire time. The commission's run
 * ledger is NOT the link: it is capped at MAX_PERSISTED_RUNS, so a project still
 * wedged after that many fires — the precise case this module exists for — has
 * already fallen out of it, and a project a plan step spawns indirectly
 * (bridgeFromIssue) never enters it at all. The ledger is still unioned in as a
 * compatibility path for projects minted before the back-pointer existed.
 *
 * Everything here runs OUTSIDE the Express request lifecycle (the store's
 * `commission:changed` bus) — no path throws out.
 */

import { commissionStore, sanitizeCommission, commissionEvents } from './store.js';
import { PROJECT_TERMINAL_STATUSES } from '../../lib/creativeDirectorPresets.js';

// The CD cognitive stages a commission's single pin drives. `evaluation` is
// deliberately absent — it is a vision API call, not a CoS agent, and pinning it
// to a CLI/TUI provider would trip agentBridge's harness-boundary guard.
export const COMMISSION_PINNED_STAGES = ['treatment', 'plan'];

// Statuses in which a project is still being driven by the advance loop, so a
// stage restart should hand it straight back. A `paused` project keeps the fresh
// provider but is NOT auto-resumed — the user parked it, and Resume is theirs.
const ADVANCING_PROJECT_STATUSES = new Set(['planning', 'rendering', 'stitching']);

/**
 * Read a commission by id INCLUDING a tombstoned one — the delete path runs
 * AFTER the tombstone lands and still needs the record. Reads raw (not
 * `getCommission`) deliberately: these paths only need the machine-local
 * assignment, and must not drag the federated feedback hydration onto an
 * event-bus handler or onto every agent dispatch.
 */
async function readCommission(id) {
  if (!id) return null;
  const raw = await commissionStore().readRaw(id, { includeDeleted: true }).catch(() => null);
  return raw ? sanitizeCommission(raw) : null;
}

/**
 * The commission's live `{ providerId, model }` pin for its CD cognitive stages,
 * or `null` to inherit the install's AI Assignment. Resolved at DISPATCH, so an
 * edit to the commission reaches work already in flight without rewriting a
 * single project record.
 *
 * A pin becomes unusable three ways — an api-type provider (trips agentBridge's
 * harness-boundary guard), a removed provider, or a provider the user later
 * DISABLED (the agent runner honors an explicit task pin without re-checking
 * `enabled`, so a disabled provider would keep launching commissions and defeat
 * the disable control). The UI only offers enabled agent-harness providers, but a
 * direct REST write, a provider whose type later changed to `api`, or a post-pin
 * disable could slip a bad pin past it. An unusable pin is DROPPED so the stage
 * falls back to the install default and the commission still generates rather
 * than stalling. Fail open: an unresolvable provider (toolkit hiccup) also falls
 * back.
 */
export async function commissionStagePin(commissionId) {
  const commission = await readCommission(commissionId);
  const providerId = commission?.assignment?.providerId;
  if (!providerId) return null;
  const [{ getProviderById }, { PROVIDER_TYPES }] = await Promise.all([
    import('../providers.js'),
    import('../../lib/aiToolkit/constants.js'),
  ]);
  const provider = await getProviderById(providerId).catch(() => null);
  const isAgentHarness = provider?.type === PROVIDER_TYPES.CLI || provider?.type === PROVIDER_TYPES.TUI;
  if (!isAgentHarness || provider?.enabled === false) {
    const reason = !provider ? 'missing' : (!isAgentHarness ? `non-agent:${provider.type}` : 'disabled');
    console.warn(`⚠️ Creative commission ${commissionId} pins unusable provider '${providerId}' (${reason}) — falling back to the default CD assignment`);
    return null;
  }
  return { providerId, ...(commission.assignment.model ? { model: commission.assignment.model } : {}) };
}

/**
 * Distinct CD project ids named by a commission's run ledger, newest first. Pure.
 * The compatibility half of the lookup — see `commissionProjects`.
 */
export function ledgerProjectIds(commission) {
  const seen = new Set();
  const runs = Array.isArray(commission?.runs) ? commission.runs : [];
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const id = runs[i]?.projectId;
    if (typeof id === 'string' && id && !seen.has(id)) seen.add(id);
  }
  return [...seen];
}

/**
 * Every live, non-terminal project a commission owns. Unions the authoritative
 * `commissionId` query with the run ledger, so projects minted before the
 * back-pointer existed are still reachable on an install that just upgraded.
 */
async function commissionProjects(commissionId, preread) {
  const { listProjectsByCommissionId, getProjectsByIds } = await import('../creativeDirector/local.js');
  const owned = await listProjectsByCommissionId(commissionId).catch(() => []);
  // The ledger fallback needs the record. Callers that already hold it pass it
  // in; the delete path does not, and reading it here (rather than making every
  // caller remember) is what keeps pre-back-pointer projects reachable on a
  // delete as well as a pause.
  const commission = preread || await readCommission(commissionId);
  const known = new Set(owned.map((p) => p.id));
  const legacyIds = ledgerProjectIds(commission).filter((id) => !known.has(id));
  const legacy = legacyIds.length ? await getProjectsByIds(legacyIds).catch(() => []) : [];
  return [...owned, ...legacy].filter((p) => p && !PROJECT_TERMINAL_STATUSES.has(p.status));
}

/**
 * Retire the stages a commission's projects have ALREADY dispatched, so the next
 * dispatch picks up the commission's current provider instead of the one frozen
 * in the live task's metadata, then hand each project back to the advance loop.
 *
 * Only the LLM stages are torn down — a `plan-step` run is a tool dispatch (often
 * a render already burning GPU time) and has nothing to do with the LLM pin.
 *
 * @returns {Promise<{restarted: string[], checked: number}>}
 */
export async function restartCommissionStages(commissionId, commission) {
  const projects = await commissionProjects(commissionId, commission);
  if (!projects.length) return { restarted: [], checked: 0 };

  const [{ inflightRuns, retireRuns }, { advanceAfterPlanStepSettled }] = await Promise.all([
    import('../creativeDirector/stopProject.js'),
    import('../creativeDirector/planAdvance.js'),
  ]);
  const reason = 'Creative commission provider changed';
  const restarted = [];
  for (const project of projects) {
    const stale = inflightRuns(project, COMMISSION_PINNED_STAGES);
    if (!stale.length) continue;
    await retireRuns(project.id, { runs: stale, reason })
      .catch((e) => console.error(`❌ Commission ${commissionId}: retire runs on ${project.id} failed: ${e.message}`));
    restarted.push(project.id);
    if (!ADVANCING_PROJECT_STATUSES.has(project.status)) continue;
    await advanceAfterPlanStepSettled(project.id)
      .catch((e) => console.error(`❌ Commission ${commissionId}: advance ${project.id} failed: ${e.message}`));
  }
  if (restarted.length) {
    console.log(`🎯 Commission ${commissionId} restarted ${restarted.length} in-flight stage(s) under its current provider`);
  }
  return { restarted, checked: projects.length };
}

/**
 * Hard-stop every project this commission spawned — the missing half of pausing
 * or deleting a commission. Cancelling the cron stops FUTURE fires; this stops
 * the work already running (agent processes, CoS tasks, run rows, media jobs).
 *
 * Stopped projects are parked as `paused` with the reason, NOT deleted: the
 * outputs already produced stay browsable, and the user can Resume an individual
 * project from the CD detail page if they only wanted to change the provider.
 *
 * @returns {Promise<{stopped: string[], checked: number}>}
 */
export async function stopCommissionProjects(commissionId, { reason = 'Commission stopped', commission } = {}) {
  const projects = await commissionProjects(commissionId, commission);
  if (!projects.length) return { stopped: [], checked: 0 };

  const { stopProject } = await import('../creativeDirector/stopProject.js');
  const stopped = [];
  for (const project of projects) {
    const result = await stopProject(project.id, { reason, project })
      .catch((e) => { console.error(`❌ Commission ${commissionId}: stop ${project.id} failed: ${e.message}`); return null; });
    if (result?.stopped) stopped.push(project.id);
  }
  if (stopped.length) {
    console.log(`🛑 Commission ${commissionId} stopped ${stopped.length} in-flight project(s): ${reason}`);
  }
  return { stopped, checked: projects.length };
}

// A commission mutation that cannot possibly change what its in-flight work
// should be doing. `fields` is the patched key set, absent on emitters that don't
// report one — and absent must mean "reconcile" (we cannot prove it was
// irrelevant), never "skip".
const RECONCILABLE_FIELDS = ['enabled', 'assignment'];

/**
 * The `commission:changed` reconciler — the single decision table for what a
 * commission mutation must do to the work it already spawned:
 *
 *   delete            → stop everything (the user removed the job).
 *   update + disabled → stop everything (Pause means STOP, not "let it keep
 *                       retrying with no way to intervene").
 *   update + enabled  → restart the stages already dispatched, so they pick up
 *   restore             the commission's current provider on re-dispatch.
 *   create            → nothing; a brand-new commission has spawned nothing.
 *   merge (no id)     → nothing; a peer merge only carries the federated brief,
 *                       never the machine-local schedule/assignment/runs.
 *
 * Never throws — it runs on an EventEmitter callback, outside any request.
 */
export async function reconcileCommissionProjects({ id, action, fields } = {}) {
  if (!id || action === 'create') return { action: 'noop' };
  if (action === 'delete') {
    await stopCommissionProjects(id, { reason: 'Creative commission deleted' });
    return { action: 'stopped' };
  }
  if (Array.isArray(fields) && !fields.some((f) => RECONCILABLE_FIELDS.includes(f))) {
    return { action: 'noop' };
  }
  const commission = await readCommission(id);
  if (!commission) return { action: 'noop' };
  if (commission.enabled === false) {
    await stopCommissionProjects(id, { reason: 'Creative commission paused', commission });
    return { action: 'stopped' };
  }
  await restartCommissionStages(id, commission);
  return { action: 'restarted' };
}

/**
 * Subscribe the reconciler to every commission write. Lives here rather than in
 * the cron scheduler so that module stays about arming crons; called once at
 * import by whoever pulls this module into the boot graph.
 */
export function registerCommissionProjectReconciler() {
  commissionEvents.on('commission:changed', (change) => {
    reconcileCommissionProjects(change).catch((err) =>
      console.error(`❌ Creative commission project reconcile failed: ${err.message}`));
  });
}

/**
 * One-shot boot backfill: stamp `commissionId` onto the projects a commission
 * spawned BEFORE the back-pointer existed, reading it out of the run ledger.
 *
 * Without this, an install upgrading with a project already wedged keeps the old
 * behavior for exactly the projects that need the fix most — the dispatch path
 * only consults a commission when the project names one, so a stuck project would
 * go on handing its planner task to the provider frozen at fire time even after
 * the user re-pointed the commission. The ledger is capped, so this recovers what
 * it still remembers; anything already evicted stays unlinked (nothing else can
 * recover it, and a fresh fire mints a correctly-stamped project).
 *
 * Pure data movement, no LLM. Idempotent: a project that already carries the
 * back-pointer is skipped, so a re-run writes nothing. Best-effort — a failure
 * leaves the install exactly as it was.
 *
 * @returns {Promise<{stamped: number}>}
 */
export async function backfillProjectCommissionIds() {
  const ids = await commissionStore().listIds({ includeDeleted: true }).catch(() => []);
  if (!ids.length) return { stamped: 0 };

  const { getProjectsByIds, updateProject } = await import('../creativeDirector/local.js');
  let stamped = 0;
  for (const commissionId of ids) {
    const commission = await readCommission(commissionId);
    const legacyIds = ledgerProjectIds(commission);
    if (!legacyIds.length) continue;
    const projects = await getProjectsByIds(legacyIds).catch(() => []);
    for (const project of projects) {
      if (!project || project.commissionId) continue;
      const ok = await updateProject(project.id, { commissionId })
        .then(() => true)
        .catch((e) => { console.error(`❌ Commission back-pointer backfill: ${project.id} failed: ${e.message}`); return false; });
      if (ok) stamped += 1;
    }
  }
  if (stamped) console.log(`🎯 Commission back-pointer backfill: stamped ${stamped} pre-existing project(s)`);
  return { stamped };
}

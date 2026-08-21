/**
 * Measure every local model in one pass — the overnight sweep.
 *
 * Measuring one model takes minutes; measuring a machine's worth of them takes
 * hours. That is a job you start at the end of the day and read in the morning,
 * which rules out the shape the single-model path uses (one blocking POST held
 * open by the browser tab). This module runs the queue SERVER-SIDE: the request
 * that starts it returns immediately, the loop keeps going with nobody watching,
 * and the page reads its progress from a status endpoint plus the existing
 * `localLlm:progress` socket event.
 *
 * ## AI Provider Usage Policy (root CLAUDE.md) — read before editing
 *
 * A sweep calls a provider once per model, so it is STRICTLY user-triggered, the
 * same as the single-model run:
 *
 *   - `startSweep()` is reachable only from `POST /api/local-llm/assessments/sweep`,
 *     behind a consent gate that names the exact model count and generation count.
 *   - `getSweepStatus()` reads module state only. Zero LLM calls, safe to poll.
 *
 * The prohibition the single-model service states — "no scheduler, no boot hook,
 * no background sweep" — is about work the user did not ask for. This IS the ask:
 * a button they pressed, having been told what it will run. What must never
 * appear is a cron entry, a boot hook, or an auto-start that fires this without a
 * click. Do not add one.
 *
 * `lib/sseUtils.js#createSseRunner` owns a similar lifecycle (runId, abort,
 * cancel, active-guard) but is SSE-transport-bound and keeps no cumulative record
 * of what a run has produced so far — which is the one thing a page reloaded at
 * 3am needs. Hence a small queue of its own rather than a transport it would have
 * to work around.
 *
 * ## Restart behavior
 *
 * The queue lives in module memory, so a server restart mid-sweep ends it. That
 * is deliberate rather than unfinished: every COMPLETED measurement is already
 * durable (`runAssessment` persists as it goes), so a restart costs the model in
 * flight and nothing else, and re-running the sweep afterwards picks up exactly
 * what is still unmeasured. Persisting the queue would buy a resumable pointer
 * into a job that is cheap to restart and must never auto-resume on boot.
 */

import { selectSweepTargets, SWEEP_SCOPES } from '../lib/localModelAssessment.js';
import { getAssessmentReport, runAssessment } from './localModelAssessments.js';

// One sweep at a time. This is a re-entrancy guard, not a concurrency control:
// PortOS serves one user, and the thing being prevented is a second click (or a
// second tab) queuing the same models against a machine that can only run one
// model at a time anyway.
let sweep = null;

// Held across `startSweep`'s `await getAssessmentReport()`. The `sweep` object
// itself cannot be published until the targets are known, so without this a
// second request arriving during that await passes the "already running" check,
// and both requests go on to assign `sweep` and launch a detached loop — two
// overnight queues measuring the same models against each other, with only the
// second one's status visible. The slot has to be reserved SYNCHRONOUSLY, before
// the first await, or the check and the claim are not atomic.
let startingSweep = false;

// A sweep is sequential BY DESIGN. Two models measured at once contend for the
// same memory and the same GPU, and every number either one produces would
// describe that contention rather than the model — which is the one thing this
// whole feature exists to measure accurately.

// How long one model waits for the machine-wide accelerator claim before giving
// up on its turn. An interactive Measure click refuses immediately; a queue
// running unattended should ride out a short image render rather than throwing
// away a model's slot over it — but not wait all night behind a LoRA training
// run, which would leave the sweep looking hung with nothing to show.
const CLAIM_WAIT_MS = 10 * 60 * 1000;

const nowIso = () => new Date().toISOString();

/** Public snapshot. Never leaks the AbortController or the emit hook. */
function snapshot() {
  if (!sweep) {
    // `status: 'idle'` with a null run is the honest "nothing has been started",
    // distinct from a finished sweep whose results are still worth showing.
    return { status: 'idle', scope: null, startedAt: null, finishedAt: null, total: 0, completed: 0, current: null, results: [], cancelRequested: false };
  }
  return {
    status: sweep.status,
    scope: sweep.scope,
    startedAt: sweep.startedAt,
    finishedAt: sweep.finishedAt,
    total: sweep.total,
    completed: sweep.results.length,
    // Which model is being measured right now — `null` between models and once
    // the sweep ends.
    current: sweep.current,
    results: sweep.results,
    cancelRequested: sweep.cancelRequested,
    error: sweep.error || null,
  };
}

export function getSweepStatus() {
  return snapshot();
}

/**
 * Ask the running sweep to stop.
 *
 * Aborts the model in flight (which `runAssessment` treats as a cancel and does
 * NOT record) and drops the rest of the queue. Everything already measured stays
 * on disk — an interrupted overnight run is still worth what it finished.
 */
export function cancelSweep() {
  if (!sweep || sweep.status !== 'running') return snapshot();
  sweep.cancelRequested = true;
  sweep.controller.abort();
  // Flip the status here rather than waiting for the loop's `finally`: the
  // caller is an HTTP handler returning this snapshot NOW, and reporting
  // `running` to a client that just stopped it would leave a Stop button on
  // screen for a queue that is already winding down. The `finally` re-affirms
  // `cancelled` (it reads the same flag), so the two cannot disagree.
  sweep.status = 'cancelled';
  console.log(`🛑 Local LLM: assessment sweep cancelled after ${sweep.results.length}/${sweep.total}`);
  return snapshot();
}

/** Test seam: forget any sweep state between suites. */
export function __resetSweep() {
  sweep?.controller?.abort();
  sweep = null;
  startingSweep = false;
}

// The sweep loop runs OUTSIDE the request lifecycle — there is no `next(err)` to
// bubble to, so an uncaught throw here would take the process down (root
// CLAUDE.md). Every model is individually caught, and the loop itself is wrapped.
//
// It mutates the `run` it was handed, NOT the module-level `sweep`: a cancelled
// queue is replaceable the moment it is cancelled, and a loop still winding down
// its last model must not write its results into the sweep that succeeded it.
async function runSweepLoop(run, targets, contextTokens, emit) {
  for (const target of targets) {
    if (run.cancelRequested) break;
    run.current = { backend: target.backend, modelId: target.modelId, tuningLabel: target.tuningLabel, startedAt: nowIso() };
    emit({
      scope: 'assessment-sweep',
      event: 'model-start',
      backend: target.backend,
      modelId: target.modelId,
      completed: run.results.length,
      total: run.total,
      message: `Sweep ${run.results.length + 1}/${run.total}: measuring ${target.modelId}…`,
    });

    // One model failing is a RESULT, not a reason to abandon the queue — the
    // whole point of an overnight run is that it gets through the list.
    const result = await runAssessment({
      backend: target.backend,
      modelId: target.modelId,
      contextTokens,
      tuning: target.tuning,
      signal: run.controller.signal,
      onProgress: emit,
      claimTimeoutMs: CLAIM_WAIT_MS,
    }).catch((err) => ({ error: err?.message || 'assessment failed' }));

    run.current = null;
    // A cancelled run recorded nothing, so it is not a result — recording it as
    // one would make a stopped sweep look like it measured what it abandoned.
    if (result?.cancelled) break;
    run.results.push({
      backend: target.backend,
      modelId: target.modelId,
      tuningLabel: target.tuningLabel,
      finishedAt: nowIso(),
      // `null` verdict + an error means the run threw before producing evidence.
      verdict: result?.error ? null : (result?.verdict || 'unknown'),
      error: result?.error || null,
      meanTokensPerSecond: Number.isFinite(result?.performance?.meanTokensPerSecond) ? result.performance.meanTokensPerSecond : null,
      meanCharsPerSecond: Number.isFinite(result?.performance?.meanCharsPerSecond) ? result.performance.meanCharsPerSecond : null,
      // Travels WITH the rate it qualifies. Dropping it here would render a
      // frame-counted estimate as a tokenizer measurement in the results list.
      tokensEstimated: typeof result?.performance?.tokensEstimated === 'boolean' ? result.performance.tokensEstimated : null,
    });
  }
}

/**
 * Start measuring every model the scope covers. **Calls a provider, once per
 * model** — see the policy note at the top.
 *
 * Returns as soon as the queue is built: the loop runs detached so the HTTP
 * request that started it can return, and so closing the browser does not stop
 * an overnight run.
 *
 * @param {object} options
 * @param {'unmeasured'|'stale'|'all'} [options.scope]
 * @param {number[]} [options.contextTokens] passed through to each measurement
 * @param {(frame: object) => void} [options.onProgress] forwarded to the socket
 * @returns {Promise<object>} the initial snapshot, or `{ rejected }` when a
 *   sweep is already running or the scope covers nothing
 */
export async function startSweep({ scope = 'unmeasured', contextTokens, onProgress } = {}) {
  if (sweep?.status === 'running' || startingSweep) return { ...snapshot(), rejected: 'a sweep is already running' };
  // Reserved here, synchronously, so the check above and this claim cannot be
  // split by the await inside. Released in the `finally` — by which point either
  // `sweep` is published (and the `running` check covers the slot) or the start
  // was refused and the slot is free again.
  startingSweep = true;
  try {
    return await beginSweep({ scope, contextTokens, onProgress });
  } finally {
    startingSweep = false;
  }
}

async function beginSweep({ scope, contextTokens, onProgress }) {
  const resolvedScope = SWEEP_SCOPES.includes(scope) ? scope : 'unmeasured';

  // Read the report ONCE, here, rather than per model: it lists installed models
  // across every runtime and annotates staleness, which is exactly the input the
  // target selection needs. It is disk-plus-listing only — no LLM call.
  const report = await getAssessmentReport({ intent: 'balanced' });
  const uninstalledKeys = new Set(report.uninstalled.map((u) => `${u.backend}:${u.modelId}`));
  const targets = selectSweepTargets({
    // Records for models that are no longer installed cannot be re-measured, so
    // they never enter the queue.
    assessments: report.assessments.filter((a) => !uninstalledKeys.has(`${a?.backend}:${a?.modelId}`)),
    unassessed: report.unassessed,
    scope: resolvedScope,
  });

  if (!targets.length) return { ...snapshot(), rejected: 'nothing to measure for that scope' };

  const emit = (frame) => {
    if (typeof onProgress !== 'function') return;
    // A broken listener (a closed socket) must never abort a job the user is
    // paying hours of compute for.
    try { onProgress(frame); }
    catch (err) { console.error(`❌ Local LLM: sweep progress listener failed: ${err.message}`); }
  };

  const run = {
    status: 'running',
    scope: resolvedScope,
    startedAt: nowIso(),
    finishedAt: null,
    total: targets.length,
    current: null,
    results: [],
    cancelRequested: false,
    error: null,
    controller: new AbortController(),
  };
  sweep = run;

  console.log(`📏 Local LLM: assessment sweep started — ${targets.length} measurement${targets.length === 1 ? '' : 's'} (${resolvedScope})`);
  emit({ scope: 'assessment-sweep', event: 'start', total: targets.length, completed: 0, message: `Measuring ${targets.length} model${targets.length === 1 ? '' : 's'}…` });

  // Detached on purpose: the caller is an HTTP handler that must return now.
  runSweepLoop(run, targets, contextTokens, emit)
    .catch((err) => {
      run.error = err?.message || 'sweep failed';
      console.error(`❌ Local LLM: assessment sweep failed: ${run.error}`);
    })
    .finally(() => {
      run.status = run.cancelRequested ? 'cancelled' : (run.error ? 'failed' : 'complete');
      run.finishedAt = nowIso();
      run.current = null;
      console.log(`📏 Local LLM: assessment sweep ${run.status} — ${run.results.length}/${run.total} measured`);
      // A queue the user already replaced has nothing to report — emitting its
      // terminal frame would tell the page the CURRENT sweep just finished.
      if (sweep !== run) return;
      emit({
        scope: 'assessment-sweep',
        event: 'complete',
        status: run.status,
        completed: run.results.length,
        total: run.total,
        message: `Sweep ${run.status}: ${run.results.length}/${run.total} measured`,
      });
    });

  return snapshot();
}

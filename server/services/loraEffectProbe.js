/**
 * User-triggered LoRA adapter-effect diagnostic.
 *
 * Spawns `scripts/lora_effect_probe.py` against one installed LoRA and answers
 * the question none of the existing gates do: does this adapter actually change
 * anything? See `server/lib/loraEffect.js` for the verdict policy and
 * `scripts/lora_effect_probe.py` for the measurement.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **Never on a passive read.** `listLoras()` surfaces a CACHED report and
 *    never calls in here. The probe runs only from the explicit inspection
 *    route or from the render path that is about to spend GPU minutes on the
 *    adapter — both of which are a user asking for the answer.
 *
 * 2. **Cached in the sidecar, keyed by probe version + file size + mtime.** A
 *    LoRA is measured once; every later render and every library page reads the
 *    stored report for free. Bumping the probe, or any rewrite of the file
 *    (including a same-size one), re-measures. An `unmeasurable` result is
 *    deliberately NOT cached — it describes this machine's Python, not the
 *    adapter, and caching it would make a transient environment problem
 *    permanent. The ONE exception is our own timeout: that describes what
 *    reading this file costs on this storage, which is what the key already
 *    scopes, and without caching it a slow adapter re-burns the budget before
 *    every render.
 *
 * 3. **Never fatal.** Every PROBE failure — no interpreter, no numpy, spawn
 *    error, timeout, malformed output — resolves to an `unmeasurable` report.
 *    Two caller errors still throw, because they are not probe failures: an
 *    unsafe filename, and a LoRA that isn't on disk (a 404, as everywhere else).
 *    The diagnostic refuses a render only on a positive measurement of zero
 *    effect (`loraEffectIssue`), so a machine that cannot run the probe is a
 *    machine that renders exactly as it did before this existed.
 */

import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import { runSidecarProcess, parseSidecarResult } from '../lib/sidecarProcess.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import {
  LORA_EFFECT_PROBE_VERSION,
  LORA_EFFECT_STATUSES,
  normalizeLoraEffectReport,
  readCachedLoraEffectReport,
} from '../lib/loraEffect.js';
import { detectPython, NUMPY_PYTHON_RESOLVERS } from '../lib/pythonSetup.js';
import { LTX2_VENV_PYTHON, LTX25_VENV_PYTHON } from './videoGen/runtimes.js';
import { assertSafeLoraFilename, patchLoraSidecar, readSidecar } from './loras.js';

export const LORA_EFFECT_PROBE_SCRIPT = join(PATHS.root, 'scripts', 'lora_effect_probe.py');

// The measurement is CPU-trivial but I/O-bound: the rank matrices are scattered
// through the file, so a cold-cache read touches most of it. A 1 GB video LoRA
// measures in about a second; a 12 GB one took ~55s cold on a local SSD. This
// bound is therefore sized to catch a wedged interpreter, NOT to cap a slow
// read — timing out a legitimate measurement would report 'unmeasurable' for
// exactly the largest adapters, where a wasted render costs the most.
//
// It is a budget for the WHOLE candidate walk, not per interpreter: this runs
// inline ahead of a render, before the job even has an id to report progress
// against, so N installed venvs must not be able to multiply the stall.
export const LORA_EFFECT_PROBE_BUDGET_MS = 300_000;
const PROBE_TIMEOUT_MS = LORA_EFFECT_PROBE_BUDGET_MS;

const installedCandidates = (paths) => [
  ...new Set(paths.filter((p) => typeof p === 'string' && p && existsSync(p))),
];

// The probe needs numpy and nothing else, so it runs on whichever provisioned
// venv exists — NUMPY_PYTHON_RESOLVERS (lib/pythonSetup.js) owns that roster so
// a newly-provisioned runtime is added in one place. The LTX-2.x video venvs go
// first because they are the runtimes that actually fuse video LoRAs, and their
// paths live in videoGen/runtimes.js rather than pythonSetup.
//
// Ordered rather than single because a venv can exist without numpy; the probe
// reports that with a distinct exit code so the loop advances to the next
// interpreter instead of blaming the adapter.
const probeInterpreterCandidates = async () => {
  // `existsSync` here (rather than trusting the resolvers) keeps a spawn ENOENT
  // out of the common path; a resolver that already checked pays only a stat.
  const installed = installedCandidates([
    LTX2_VENV_PYTHON,
    LTX25_VENV_PYTHON,
    ...NUMPY_PYTHON_RESOLVERS.map((resolve) => resolve()),
  ]);
  // detectPython() is awaited ONLY when no provisioned venv exists. It execs
  // every system interpreter to read its arch (or shells out to `which`), which
  // is several process launches — wasted on any machine that can actually fuse a
  // video LoRA, since such a machine has one of the venvs above by definition.
  if (installed.length) return installed;
  return installedCandidates([await detectPython()]);
};

const timeoutReport = () => unmeasurable(
  `the effect probe ran out of its ${PROBE_TIMEOUT_MS / 1000}s budget reading this adapter`,
);

// Stamped with the CURRENT probe version because we are BUILDING this report,
// not reading one: a locally-constructed verdict is current by definition.
// Without the stamp it normalizes to version 0, and caching a timeout becomes a
// silent no-op — the freshness check rejects its own freshly-written value, so
// the stall the cache exists to prevent repeats before every render. The shared
// normalizer deliberately does NOT infer this: an absent version in a SIDECAR
// means "written by something that didn't stamp it", which stays untrusted.
const unmeasurable = (reason) => normalizeLoraEffectReport({
  probeVersion: LORA_EFFECT_PROBE_VERSION,
  status: LORA_EFFECT_STATUSES.UNMEASURABLE,
  reason,
});

// One measurement per file at a time. A user mashing the inspect button, or a
// render that selected the same LoRA twice, shares one child rather than
// spawning a pile of interpreters against the same weights.
const inFlight = createSingleFlight();

// Returns `{ report, timedOut }`. `timedOut` is what stops the candidate walk:
// a timeout says the FILE is slow to read, which every interpreter would be
// equally slow at, so retrying is guaranteed waste. Every other failure is about
// this interpreter (no numpy, a broken venv) and is worth another candidate.
const runProbeOnce = async (bin, filePath, budgetMs) => {
  // try/catch is warranted here despite the repo's no-try/catch rule: this runs
  // outside the Express lifecycle (a background render job awaits it), and
  // runSidecarProcess only *models* failures as resolutions — the underlying
  // `spawn` can still throw synchronously on a malformed argv, which rejects the
  // promise it never catches. Letting that escape would take down a render over
  // a diagnostic. withAbortTimeout owns the timer lifecycle and clears it on
  // both settle paths.
  let result;
  // runSidecarProcess's abort handler only SIGTERMs. A python child blocked in
  // an uninterruptible read (a network or iCloud-backed volume — exactly the
  // storage that makes this time out) never reaches its signal handler, so the
  // promise would never settle and the render would wait past its own timeout,
  // forever. Hold the handle and escalate to SIGKILL, as every other
  // runSidecarProcess caller does.
  let child = null;
  // OUR timeout, specifically. `result.canceled` is set for ANY SIGTERM/SIGKILL
  // death of the child — an OOM kill, a stray pkill, a process-group signal
  // during shutdown — and only our own budget expiring may be reported as (and
  // cached as) a timeout. Reading them as the same thing would permanently badge
  // an adapter "Not measurable" because something unrelated killed one probe.
  let didTimeout = false;
  try {
    result = await withAbortTimeout(budgetMs, (signal) => {
      signal.addEventListener('abort', () => {
        didTimeout = true;
        if (child) killWithEscalation(child, { label: 'LoRA effect probe', stillRunning: () => true });
      }, { once: true });
      return runSidecarProcess({
        bin,
        args: [LORA_EFFECT_PROBE_SCRIPT, filePath],
        signal,
        onProcess: (proc) => { child = proc; },
      });
    });
  } catch (err) {
    return { report: unmeasurable(`the effect probe could not be started (${err?.message || err})`) };
  }
  // The probe prints RESULT: even when it exits non-zero (the missing-numpy
  // case), so parse stdout before judging the exit — an exit code alone would
  // throw away the reason the caller needs.
  const parsed = parseSidecarResult(result.stdout);
  // `parsed` is whatever JSON.parse produced, so a `RESULT:[1,2]` line is truthy
  // but not a report; normalizeLoraEffectReport answers null for it and the
  // caller needs the honest "no result" reason, not a null dereference.
  const report = parsed ? normalizeLoraEffectReport(parsed) : null;
  if (report) return { report };
  if (didTimeout) return { report: timeoutReport(), timedOut: true };
  if (result.canceled) {
    // Killed by something that isn't us — report it honestly and let the walk
    // try another interpreter; nothing about the adapter has been learned.
    return { report: unmeasurable(`the effect probe was killed (${result.reason || 'signal'})`) };
  }
  return { report: unmeasurable(`the effect probe produced no result (${result.reason || 'no output'})`) };
};

// The measurement proper — everything after the cache miss. Split out so the
// never-fatal guarantee is one `.catch` at the single call site below rather
// than a defensive wrapper around each step.
const measureLoraEffect = async (filename, filePath, { sizeBytes, mtimeMs, deadline }) => {
  const candidates = await probeInterpreterCandidates();
  if (!candidates.length) {
    return unmeasurable('no Python interpreter with numpy is installed — set up a Video Gen or Image Gen runtime first');
  }
  // A cold read of a multi-GB adapter takes real time (see PROBE_TIMEOUT_MS),
  // and this runs inline ahead of a render — say so, or the pause looks like a
  // hang with nothing in the log.
  console.log(`🔬 Measuring LoRA effect for ${filename} (${Math.round(sizeBytes / 1e6)} MB)`);
  let last = null;
  let timedOut = false;
  for (const bin of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { timedOut = true; break; }
    const attempt = await runProbeOnce(bin, filePath, remaining);
    last = attempt.report;
    timedOut = attempt.timedOut === true;
    // Only an unmeasurable verdict is worth another interpreter; every other
    // status is a real answer about the file and identical on any Python. A
    // timeout stops the walk outright — see runProbeOnce.
    if (timedOut || last.status !== LORA_EFFECT_STATUSES.UNMEASURABLE) break;
  }
  // The budget can also run out BETWEEN candidates, leaving `last` holding the
  // previous interpreter's verdict — very possibly "numpy is not installed",
  // which is about this machine and must never be cached. Rebuild the report
  // from the timeout so what gets stored describes what actually happened.
  if (timedOut) last = timeoutReport();
  if (last === null) last = timeoutReport();
  if (last.status === LORA_EFFECT_STATUSES.UNMEASURABLE) {
    console.log(`⚠️ LoRA effect probe unavailable for ${filename}: ${last.reason || 'unknown'}`);
    // A timeout is cached, unlike every other unmeasurable verdict. The others
    // describe this machine's Python — a venv the user may install in a minute,
    // so freezing them in would make a transient problem permanent. A timeout
    // instead describes the cost of READING THIS FILE on this storage, which is
    // exactly what the size+mtime cache key already scopes. Without caching it,
    // a pathologically slow adapter re-burns the full budget ahead of every
    // single render, forever.
    if (!timedOut) return last;
    // NOT named `timeoutReport`: that is a module-level helper, and shadowing it
    // here would turn any future call to it earlier in this block into a TDZ
    // ReferenceError rather than the helper.
    const cachedTimeout = normalizeLoraEffectReport(last, { sizeBytes, mtimeMs, measuredAt: new Date().toISOString() });
    await patchLoraSidecar(filename, { effectReport: cachedTimeout }).catch(() => {});
    return cachedTimeout;
  }
  const report = normalizeLoraEffectReport(last, { sizeBytes, mtimeMs, measuredAt: new Date().toISOString() });
  console.log(`🔬 LoRA effect ${filename}: ${report.status} (${report.measured}/${report.modules} modules)`);
  // Best-effort cache — a sidecar we can't write is a slower diagnostic, not a
  // failed one.
  await patchLoraSidecar(filename, { effectReport: report }).catch((err) => {
    console.log(`⚠️ Could not cache LoRA effect report for ${filename}: ${err?.message || err}`);
  });
  return report;
};

/**
 * Measure one installed LoRA's adapter effect.
 *
 * Returns a normalized report (never throws for a probe failure — see the
 * module header). `force: true` re-measures even when a fresh cached report
 * exists, which is what the manager's explicit re-check button passes.
 *
 * `deadline` (an epoch ms) lets a caller measuring SEVERAL adapters share one
 * budget across all of them. Without it a 4-LoRA render could stall for four
 * full budgets back to back, before the job even has an id to report against.
 */
export const probeLoraEffect = async (filename, { force = false, deadline = null } = {}) => {
  assertSafeLoraFilename(filename);
  const filePath = join(PATHS.loras, filename);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    // NOT a soft `unmeasurable`: that word is reserved for "this machine could
    // not run the probe", and answering it here would tell the user their
    // adapter is unmeasurable when it simply isn't there. A missing file is a
    // caller-visible 404 exactly as it is for getLora/patch/delete, and it is
    // outside the never-fatal contract for the same reason the filename
    // assertion above is. `resolveVideoLoras` already proved the file exists
    // before it probes, so the render path cannot reach this.
    throw new ServerError(`LoRA not found: ${filename}`, { status: 404, code: 'NOT_FOUND' });
  }
  // The cache key: both stamps come from the stat we already did, so verifying a
  // stored report costs nothing and a same-size rewrite still invalidates it.
  const stamps = { sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs };

  if (!force) {
    const cached = readCachedLoraEffectReport((await readSidecar(filename))?.effectReport, stamps);
    if (cached) return cached;
  }

  // The one catch that makes "never fatal" true for everything downstream of
  // the cache check: an interpreter resolver that throws, a sidecar write that
  // rejects in an unmodelled way, anything. `assertSafeLoraFilename` above is
  // deliberately OUTSIDE it — a path-traversal attempt is a caller bug that
  // must still surface as a 400, not be swallowed into a soft verdict.
  // A caller-supplied deadline can only ever SHORTEN the budget — it is a
  // shared allowance, not a way to ask for more time than the probe permits.
  const ownDeadline = Date.now() + PROBE_TIMEOUT_MS;
  const effectiveDeadline = deadline == null ? ownDeadline : Math.min(deadline, ownDeadline);

  return inFlight.run(filePath, () => measureLoraEffect(filename, filePath, { ...stamps, deadline: effectiveDeadline })
    .catch((err) => {
      console.log(`⚠️ LoRA effect probe failed for ${filename}: ${err?.message || err}`);
      return unmeasurable(`the effect probe failed unexpectedly (${err?.message || err})`);
    }));
};

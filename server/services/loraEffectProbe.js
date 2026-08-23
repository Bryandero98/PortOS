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
 * 2. **Cached in the sidecar, keyed by file size + probe version.** A LoRA is
 *    measured once; every later render and every library page reads the stored
 *    report for free. Replacing the file (different size) or bumping the probe
 *    re-measures. An `unmeasurable` result is deliberately NOT cached — it
 *    describes this machine's Python, not the adapter, and caching it would
 *    make a transient environment problem permanent.
 *
 * 3. **Never fatal.** Every failure path — no interpreter, no numpy, spawn
 *    error, timeout, malformed output — resolves to an `unmeasurable` report.
 *    The diagnostic refuses a render only on a positive measurement of zero
 *    effect (`loraEffectIssue`), so a machine that cannot run the probe is a
 *    machine that renders exactly as it did before this existed.
 */

import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { createSingleFlight } from '../lib/singleFlight.js';
import { runSidecarProcess, parseSidecarResult } from '../lib/sidecarProcess.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import {
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
const PROBE_TIMEOUT_MS = 300_000;

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

const unmeasurable = (reason) => normalizeLoraEffectReport({
  status: LORA_EFFECT_STATUSES.UNMEASURABLE,
  reason,
});

// One measurement per file at a time. A user mashing the inspect button, or a
// render that selected the same LoRA twice, shares one child rather than
// spawning a pile of interpreters against the same weights.
const inFlight = createSingleFlight();

const runProbeOnce = async (bin, filePath) => {
  // try/catch is warranted here despite the repo's no-try/catch rule: this runs
  // outside the Express lifecycle (a background render job awaits it), and
  // runSidecarProcess only *models* failures as resolutions — the underlying
  // `spawn` can still throw synchronously on a malformed argv, which rejects the
  // promise it never catches. Letting that escape would take down a render over
  // a diagnostic. withAbortTimeout owns the timer lifecycle and clears it on
  // both settle paths.
  let result;
  try {
    result = await withAbortTimeout(PROBE_TIMEOUT_MS, (signal) => runSidecarProcess({
      bin,
      args: [LORA_EFFECT_PROBE_SCRIPT, filePath],
      signal,
    }));
  } catch (err) {
    return unmeasurable(`the effect probe could not be started (${err?.message || err})`);
  }
  // The probe prints RESULT: even when it exits non-zero (the missing-numpy
  // case), so parse stdout before judging the exit — an exit code alone would
  // throw away the reason the caller needs.
  const parsed = parseSidecarResult(result.stdout);
  if (parsed) return normalizeLoraEffectReport(parsed);
  if (result.canceled) return unmeasurable(`the effect probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`);
  return unmeasurable(`the effect probe produced no result (${result.reason || 'no output'})`);
};

// The measurement proper — everything after the cache miss. Split out so the
// never-fatal guarantee is one `.catch` at the single call site below rather
// than a defensive wrapper around each step.
const measureLoraEffect = async (filename, filePath, { sizeBytes, mtimeMs }) => {
  const candidates = await probeInterpreterCandidates();
  if (!candidates.length) {
    return unmeasurable('no Python interpreter with numpy is installed — set up a Video Gen or Image Gen runtime first');
  }
  // A cold read of a multi-GB adapter takes real time (see PROBE_TIMEOUT_MS),
  // and this runs inline ahead of a render — say so, or the pause looks like a
  // hang with nothing in the log.
  console.log(`🔬 Measuring LoRA effect for ${filename} (${Math.round(sizeBytes / 1e6)} MB)`);
  let last = null;
  for (const bin of candidates) {
    last = await runProbeOnce(bin, filePath);
    // Only an unmeasurable verdict is worth another interpreter; every other
    // status is a real answer about the file and identical on any Python.
    if (last.status !== LORA_EFFECT_STATUSES.UNMEASURABLE) break;
  }
  if (last.status === LORA_EFFECT_STATUSES.UNMEASURABLE) {
    console.log(`⚠️ LoRA effect probe unavailable for ${filename}: ${last.reason || 'unknown'}`);
    return last;
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
 */
export const probeLoraEffect = async (filename, { force = false } = {}) => {
  assertSafeLoraFilename(filename);
  const filePath = join(PATHS.loras, filename);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) {
    return unmeasurable(`LoRA "${filename}" is not a regular file on disk`);
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
  return inFlight.run(filePath, () => measureLoraEffect(filename, filePath, stamps)
    .catch((err) => {
      console.log(`⚠️ LoRA effect probe failed for ${filename}: ${err?.message || err}`);
      return unmeasurable(`the effect probe failed unexpectedly (${err?.message || err})`);
    }));
};

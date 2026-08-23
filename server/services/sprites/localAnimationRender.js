/**
 * Sprites — the LOCAL (MiniMax H3) animation-render lane.
 *
 * Every sprite animation track used to have exactly one way to produce its
 * source clip: an observable grok TUI session (`animationWorkflow.js`). That is
 * a paid cloud call, which made the whole sprite pipeline unusable offline even
 * though PortOS already ships MiniMax H3 locally — the MLX port on Apple Silicon
 * and the diffusers/CUDA runtime on Windows and Linux (`videoGen/runtimes.js`).
 *
 * This module is the second lane. It is deliberately NOT a second copy of the
 * pipeline: everything downstream of the clip — chroma recovery, frame
 * selection, loop trimming, geometry QC, approval, atlas compile — is the same
 * deterministic postprocess both lanes hand a `source-video.mp4` to. All that
 * differs is who renders that MP4, so the only things here are:
 *
 *   - which local model this platform can render on, and whether it is ready;
 *   - how a sprite's authoring knobs (a clip length in seconds, an anchor of
 *     arbitrary aspect) map onto H3's fixed contract (a 17n+5 frame grid at a
 *     locked 24 fps, on one of six trained canvases);
 *   - queueing one render through `mediaJobQueue` and putting the finished clip
 *     where the postprocess expects it.
 *
 * Unlike the grok lane this is NOT a PTY session, so a local run has no
 * attachable Shell session. It carries a `jobId` instead, which is both what the
 * Render Queue UI shows and — via `localRunLiveness` — how a read path tells a
 * genuinely-live multi-hour render from one the server died in the middle of.
 */

import { join } from 'path';
import { copyFile } from 'fs/promises';
import { PATHS, pathExists } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getVideoModels } from '../../lib/mediaModels.js';
import { inspectModelCache, findCachedRepoFiles } from '../../lib/hfCache.js';
import { BYOV_RUNTIME_INFO, isByovRuntimeReady } from '../videoGen/runtimes.js';
import { enqueueJob, getJob, mediaJobEvents } from '../mediaJobQueue/index.js';
import { LOCAL_VIDEO_PROVIDER_ID } from './animationWorkflow.js';

// H3's video VAE decodes only 17n+5 frame counts and the model runs at a fixed
// 24 fps (both enforced by `videoGen/minimaxH3Controls.js`), so a sprite's
// requested clip length can only ever be honoured approximately. 24 is read
// from the model row when it declares one so a future re-profile moves both.
const H3_FALLBACK_FPS = 24;

// Both H3 runtimes PortOS ships. A platform exposes exactly one of them
// (`getVideoModels()` already selects the mlx or cuda bucket), so this set is
// what identifies "an H3 row" inside whichever bucket is active rather than a
// platform test of its own — which is what keeps this lane working on Linux
// CUDA installs without a second branch.
const MINIMAX_H3_RUNTIME_IDS = Object.freeze(new Set(['minimax_h3', 'minimax_h3_cuda']));

/**
 * The MiniMax H3 model row this install can render on, or null.
 *
 * `getVideoModels()` has already filtered to the active platform bucket and
 * dropped anything flagged broken there, so an H3 row surviving that filter is
 * by definition the one this machine would use. Null is the honest answer for a
 * platform with no H3 build at all (and is reported as such rather than
 * collapsing into "not installed", which would send the user to an install
 * button that cannot help them).
 */
export const resolveLocalVideoModel = () => (
  getVideoModels().find((model) => MINIMAX_H3_RUNTIME_IDS.has(model.runtime)) || null
);

/** The render fps a model row is locked to (H3: 24). */
export const localRenderFps = (model) => {
  const declared = Array.isArray(model?.fpsOptions) ? Number(model.fpsOptions[0]) : NaN;
  return Number.isFinite(declared) && declared > 0 ? declared : H3_FALLBACK_FPS;
};

/**
 * The legal H3 frame count closest to `durationSeconds` of footage.
 *
 * The sprite lanes ask for a clip length in seconds because that is what grok
 * takes; H3 takes a frame count off a fixed grid. Snapping to the CLOSEST legal
 * option (rather than rounding up) matters because the grid is coarse — at 24
 * fps the MLX options step by ~0.7 s but the CUDA window starts at 124 frames,
 * so rounding a 6 s request up would cost a materially longer render for
 * footage the packer discards anyway.
 *
 * Ties go to the shorter option: two equally-close counts render for different
 * lengths of time and the cheaper one is never the wrong call for source
 * footage the postprocess is going to resample regardless.
 */
export const resolveLocalFrameCount = (model, durationSeconds) => {
  const options = (Array.isArray(model?.frameOptions) ? model.frameOptions : [])
    .map(Number)
    .filter((frames) => Number.isFinite(frames) && frames > 0)
    .sort((a, b) => a - b);
  const fallback = Number(model?.defaultFrames);
  if (!options.length) {
    return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
  }
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return options.includes(fallback) ? fallback : options[0];
  }
  const target = seconds * localRenderFps(model);
  return options.reduce((best, frames) => (
    Math.abs(frames - target) < Math.abs(best - target) ? frames : best
  ), options[0]);
};

/**
 * The trained H3 canvas whose aspect ratio is closest to the anchor's.
 *
 * H3 renders only on the six canvases its row declares, and `generateVideo`
 * conforms a conditioning image to the chosen one with
 * `scale=increase,crop` — a CENTER CROP. Handing it a portrait sprite anchor on
 * H3's 16:9 default would therefore slice the character's head and feet off
 * before the render even starts, and the geometry QC would fail every run for a
 * reason invisible in the output. Picking the nearest-aspect canvas here (and
 * padding the input to it in `prepareWalkAnchorChromaInput`) makes that crop a
 * no-op instead.
 *
 * Ties go to the SMALLER canvas: equal aspect fidelity for less render time.
 */
export const pickLocalRenderCanvas = (model, { width, height } = {}) => {
  const presets = (Array.isArray(model?.resolutionOptions) ? model.resolutionOptions : [])
    .map((preset) => ({ width: Number(preset?.w), height: Number(preset?.h) }))
    .filter((preset) => (
      Number.isFinite(preset.width) && preset.width > 0
      && Number.isFinite(preset.height) && preset.height > 0
    ));
  const fallbackWidth = Number(model?.defaultWidth);
  const fallbackHeight = Number(model?.defaultHeight);
  const fallback = Number.isFinite(fallbackWidth) && fallbackWidth > 0
    && Number.isFinite(fallbackHeight) && fallbackHeight > 0
    ? { width: fallbackWidth, height: fallbackHeight }
    : null;
  if (!presets.length) return fallback;
  const w = Number(width);
  const h = Number(height);
  // No measurable anchor: the model's declared default is the honest choice —
  // guessing an aspect from nothing would be worse than the row's own answer.
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
    return fallback || presets[0];
  }
  const wanted = w / h;
  // Compared in LOG space so "twice as wide as wanted" and "half as wide" score
  // equally — a linear difference is asymmetric and biases every portrait
  // anchor toward the landscape presets.
  const distance = (preset) => Math.abs(Math.log((preset.width / preset.height) / wanted));
  return presets.reduce((best, preset) => {
    const delta = distance(preset) - distance(best);
    if (delta < 0) return preset;
    if (delta > 0) return best;
    return preset.width * preset.height < best.width * best.height ? preset : best;
  }, presets[0]);
};

/**
 * Whether every weight `model` needs is resolvable in the HF cache.
 *
 * Coarse ON PURPOSE relative to the render path's own preflight
 * (`assertMiniMaxH3Preflight`), which additionally verifies the pinned runtime
 * checkout is clean. Restating that contract here would be a second copy free to
 * drift; this answers the question the UI actually asks — "is there any point
 * offering the button?" — and a deeper failure still surfaces as a captured
 * error on the run record, naming the exact missing piece.
 */
const localModelWeightsCached = async (model) => {
  const [base, ...deps] = await Promise.all([
    inspectModelCache(model.repo, model.revision ? { revision: model.revision } : {}),
    ...(Array.isArray(model.requiredWeights) ? model.requiredWeights : []).map((dep) => (
      Array.isArray(dep?.files) && dep.files.length && dep.repo
        ? findCachedRepoFiles(dep.repo, dep.files, dep.revision ? { revision: dep.revision } : {})
        : Promise.resolve(null)
    )),
  ]);
  if (!base.cached) return false;
  // findCachedRepoFiles resolves to null when ANY pinned file is missing, so a
  // dependency that has no resolvable set is a hard no — but a model with no
  // requiredWeights at all (the CUDA row) never enters this loop.
  return deps.every((resolved) => Array.isArray(resolved) && resolved.length > 0);
};

/**
 * Readiness for the local lane, shaped for direct display.
 *
 * Always resolves — an unavailable lane is a `ready: false` plus a `reason`
 * naming the one thing to fix, never a throw. The client renders the reason
 * beside a disabled option, so "why can't I pick this?" is answered in place
 * rather than as a 409 after a click.
 */
export async function getLocalAnimationProviderStatus() {
  const model = resolveLocalVideoModel();
  if (!model) {
    return {
      id: 'local',
      label: 'Local (MiniMax H3)',
      ready: false,
      reason: 'This platform has no local MiniMax H3 video build — sprite animation renders on grok here.',
    };
  }
  const base = {
    id: 'local',
    label: 'Local (MiniMax H3)',
    modelId: model.id,
    modelName: model.name,
    runtime: model.runtime,
    fps: localRenderFps(model),
  };
  const runtimeLabel = BYOV_RUNTIME_INFO[model.runtime]?.label || model.runtime;
  if (!await isByovRuntimeReady(model.runtime)) {
    return {
      ...base,
      ready: false,
      reason: `The ${runtimeLabel} runtime is not installed — install it from Video Gen, then reload.`,
    };
  }
  if (!await localModelWeightsCached(model)) {
    return {
      ...base,
      ready: false,
      reason: `${model.name} is not downloaded — download it from Video Gen, then reload.`,
    };
  }
  return { ...base, ready: true, reason: null };
}

/**
 * Every animation provider the sprite lanes offer, in display order.
 *
 * grok reports `ready: true` unconditionally: it is the pre-existing default and
 * nothing here gates it, so claiming to know its CLI is installed would be an
 * invented gate that could only ever be wrong in the direction of hiding a
 * working button.
 */
export async function listAnimationProviders() {
  return [
    {
      id: 'grok',
      label: 'Grok (cloud)',
      ready: true,
      reason: null,
    },
    await getLocalAnimationProviderStatus(),
  ];
}

/**
 * Resolve the render plan for one local clip, or throw the 409 that says why
 * this install cannot render one.
 *
 * Called BEFORE the run record is written so an unusable lane costs the user a
 * clear error instead of an inert `error` run they then have to go delete.
 *
 * The canvas is NOT decided here — it depends on the anchor's aspect ratio, and
 * only the input-prep step measures that. The plan carries a `chooseCanvas` the
 * prep step calls with the measured size and hands back on its result, so the
 * measurement happens exactly once and the padded input and the render argv
 * cannot disagree about which canvas was picked.
 */
export async function planLocalAnimationRender({ durationSeconds } = {}) {
  const status = await getLocalAnimationProviderStatus();
  if (!status.ready) {
    throw new ServerError(status.reason, { status: 409, code: 'LOCAL_VIDEO_PROVIDER_NOT_READY' });
  }
  const model = resolveLocalVideoModel();
  const numFrames = resolveLocalFrameCount(model, durationSeconds);
  if (!numFrames) {
    throw new ServerError(
      `${model.name} declares no legal frame counts, so a local render cannot be sized.`,
      { status: 500, code: 'LOCAL_VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  return {
    model,
    numFrames,
    fps: localRenderFps(model),
    chooseCanvas: (anchorSize) => pickLocalRenderCanvas(model, anchorSize),
  };
}

/**
 * The provenance a local run stamps on its record, so a finished clip
 * self-documents which lane, model, runtime, and geometry produced it — the same
 * question `provider` alone answered while grok was the only lane.
 */
export const localRenderManifest = (plan, canvas) => ({
  provider: LOCAL_VIDEO_PROVIDER_ID,
  videoModelId: plan.model.id,
  videoRuntime: plan.model.runtime,
  renderFrames: plan.numFrames,
  renderFps: plan.fps,
  renderSeconds: Math.round((plan.numFrames / plan.fps) * 100) / 100,
  ...(canvas ? { renderWidth: canvas.width, renderHeight: canvas.height } : {}),
});

/**
 * Queue the render. Returns the media-job id synchronously enough to stamp on
 * the run record before anything awaits the result.
 *
 * `hidden: true` keeps the clip out of the user's video gallery: it is an
 * intermediate the sprite pipeline consumes, not a video they asked to keep.
 * `enqueueJob` rather than `enqueueUnattendedMediaJob` is deliberate — the user
 * explicitly chose the LOCAL provider, and the unattended helper's default
 * routing could send the job to a peer instead.
 */
export function enqueueLocalAnimationRender({ plan, canvas, prompt, inputAbs, owner }) {
  return enqueueJob({
    kind: 'video',
    owner,
    params: {
      modelId: plan.model.id,
      prompt,
      mode: 'image',
      sourceImagePath: inputAbs,
      ...(canvas ? { width: canvas.width, height: canvas.height } : {}),
      numFrames: plan.numFrames,
      fps: plan.fps,
      hidden: true,
    },
  }).jobId;
}

const TERMINAL_JOB_STATUSES = Object.freeze(['completed', 'failed', 'canceled']);

/**
 * Resolve when `jobId` reaches a terminal state, as `{ status, error }`.
 *
 * The immediate re-check after the listeners are attached is load-bearing, not
 * belt-and-braces: `enqueueJob` starts the worker synchronously, so a job that
 * fails fast (an unconfigured interpreter, a buildArgs throw) can settle in the
 * gap between the enqueue and this subscription — and a missed terminal event
 * strands the run at `rendering` forever with nothing to advance it.
 */
export function awaitMediaJobTerminalState(jobId) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (job) => {
      if (settled || job?.id !== jobId) return;
      settled = true;
      mediaJobEvents.off('completed', settle);
      mediaJobEvents.off('failed', settle);
      mediaJobEvents.off('canceled', settle);
      resolve({ status: job.status, error: job.error || null });
    };
    mediaJobEvents.on('completed', settle);
    mediaJobEvents.on('failed', settle);
    mediaJobEvents.on('canceled', settle);
    const current = getJob(jobId);
    if (current && TERMINAL_JOB_STATUSES.includes(current.status)) settle(current);
  });
}

/**
 * Drive one queued local render to completion and put its clip where the
 * deterministic postprocess expects it.
 *
 * Resolves either way — like the grok lane, the attach decides the outcome from
 * whether the MP4 actually landed on disk, so a failure here needs only to leave
 * the destination absent (and say why in the log).
 */
export async function collectLocalAnimationRender({ jobId, videoAbs, label }) {
  const { status, error } = await awaitMediaJobTerminalState(jobId);
  if (status !== 'completed') {
    console.error(`❌ ${label} local render ${status} [${jobId.slice(0, 8)}]: ${error || 'no error reported'}`);
    return;
  }
  // generateVideo names its output after the job id (`filename = ${jobId}.mp4`).
  const renderedAbs = join(PATHS.videos, `${jobId}.mp4`);
  if (!await pathExists(renderedAbs)) {
    console.error(`❌ ${label} local render completed without an MP4 at ${renderedAbs}`);
    return;
  }
  // COPY rather than move: the gallery record generateVideo wrote still points
  // at this file (hidden, but real), and its thumbnail sits beside it. Moving it
  // would leave a history row pointing at nothing.
  await copyFile(renderedAbs, videoAbs);
}

/**
 * Whether a `rendering` local run is still genuinely live.
 *
 * A local H3 render is a multi-HOUR job on current Apple Silicon, so the grok
 * lane's wall-clock staleness cutoff (its TUI hard cap plus a minute) would
 * declare a perfectly healthy render dead less than an hour in. The media job
 * is the real signal, and it survives a restart because the queue persists and
 * rehydrates both its queue and its archive.
 *
 * Three outcomes, deliberately not two: a job the queue has never heard of is
 * `unknown`, NOT `terminal`. Collapsing those would turn "the archive has rolled
 * past this job" into "this render failed" and mark a live run errored.
 */
export const localRunLiveness = (run) => {
  const jobId = run?.jobId;
  if (typeof jobId !== 'string' || !jobId) return 'unknown';
  const job = getJob(jobId);
  if (!job) return 'unknown';
  return TERMINAL_JOB_STATUSES.includes(job.status) ? 'terminal' : 'live';
};

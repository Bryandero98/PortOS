/**
 * Video Gen — creative-surface backend pin → job params (#3135 / #3231 Phase 4).
 *
 * A Creative Director project can pin which backend renders its video
 * (`project.renderBackend.video = { mode, modelId }`), and a creative
 * commission is the main thing that sets it: the commission's
 * `generation.videoMode` / `.videoModelId` ride onto the project it mints each
 * fire (see creativeCommissions/abilityAdapters.js#buildRenderBackendPin).
 *
 * TWO different surfaces enqueue video for such a project, and both have to
 * honor that pin:
 *
 *   1. the PLAN-driven path — the planner LLM's `media_enqueueVideoJob` tool
 *      (`services/creative/tools/media.js#enforceRenderBackendPin`); and
 *   2. the TREATMENT/SCENE path — `creativeDirector/sceneRunner.js`, which
 *      renders each treatment scene directly, with no LLM in the loop. This is
 *      the path a commission's video actually travels most of the time.
 *
 * #3135 wired only (1). So a commission pinned to Grok still rendered every
 * scene on the local MLX runtime, and an install with no `imageGen.local
 * .pythonPath` failed the whole project up front even though Grok was
 * configured, enabled, and explicitly pinned. This module is the ONE place the
 * resolution ladder and the Grok param shape live, so the two surfaces cannot
 * drift apart again.
 *
 * Both helpers take `settings` rather than reading them, so the callers keep
 * their existing single settings read per enqueue.
 */

import { RENDER_TARGET, normalizeRenderPinValue } from '../../lib/renderTargets.js';
import { nearestGrokDuration } from '../../lib/grokVideoClip.js';
import { renderTargetDefaults } from '../imageGen/cloudProviderConfig.js';
import { VIDEO_GEN_MODE, resolveVideoMode, hasVideoPin } from './modes.js';

/**
 * Resolve the video backend for a CD project through the pin ladder: the
 * project's own `renderBackend.video` pin (per-record, wins) → the surface's
 * `renderDefaults[target].videoMode` pin → the install-wide
 * `settings.videoGen.mode` pin → LOCAL. Every rung is usability-gated by
 * `resolveVideoMode`, so a pin naming a backend whose toggle has since been
 * switched off degrades to local rather than bricking a nightly commission.
 *
 * `pinned` reports whether ANY rung named a backend (presence only, no
 * usability gating) — it's what lets a caller with a "byte-identical when
 * nothing is pinned" contract (enforceRenderBackendPin) return the caller's
 * params untouched instead of re-deriving them.
 *
 * `modelId` is the pinned LOCAL model: the project pin's own id wins over the
 * target default's, matching the mode ladder's precedence. Local is the only
 * video backend with a model knob (the cloud CLIs pick their own), so there is
 * no cross-provider leak to guard against — but callers must still only apply
 * it on the local branch.
 */
export function resolveVideoBackendPin(project, settings, { target = RENDER_TARGET.CREATIVE_AGENT } = {}) {
  const raw = project?.renderBackend?.video || null;
  // Normalize the project's own pin through the SAME rule the settings rungs
  // use (`normalizeRenderPinValue`): the `'auto'` sentinel and blank strings
  // mean "no pin — fall through". A bare truthiness check would read a stored
  // `{ mode: 'auto' }` as a real pin and cost the caller its byte-identical
  // passthrough. Commissions never persist `auto` (buildRenderBackendPin drops
  // it), but a hand-made or peer-synced project can carry the sentinel.
  const mode = normalizeRenderPinValue(raw?.mode);
  const modelId = normalizeRenderPinValue(raw?.modelId);
  const targetDefaults = renderTargetDefaults(settings, target);
  return {
    pinned: !!mode || hasVideoPin(settings, { target }),
    // What the project ASKED for, normalized — null when it pinned nothing.
    // Distinct from `mode` (what it GOT): when the two disagree, the ladder
    // degraded an unusable pin, and only the caller has the context to decide
    // whether that's worth reporting.
    requested: mode,
    mode: resolveVideoMode(mode, settings, { target }),
    modelId: modelId || targetDefaults.videoModel || null,
  };
}

/**
 * The Grok-lane job params for a video render.
 *
 * `mode: 'grok'` is the media-job queue's backend discriminator (it dispatches
 * to videoGen/grok.js on exactly this key); the t2v/i2v semantic that the local
 * lane keeps in `mode` travels as `videoMode` instead, matching what
 * routes/videoGen.js enqueues. videoGen/grok.js reads the same
 * `settings.imageGen.grok` slice the image path does — one CLI, one config.
 *
 * Clip length crosses a contract boundary here: every other surface authors a
 * duration in the local lane's continuous seconds, while Grok delivers 6s or
 * 10s and nothing else (measured — see lib/grokVideoClip.js). Without the
 * translation a 10s scene would silently come back 6s, because grok.js defaults
 * anything undeliverable to its 6s minimum. `nearestGrokDuration` rounds UP to
 * the shortest clip that still covers the request, which is free: a shorter
 * request costs the same wall clock and returns the same footage.
 *
 * `width`/`height` are optional and only used by grok.js to derive an aspect
 * ratio for the base image it generates; when omitted it falls back to the
 * configured `imageGen.grok.aspectRatio`.
 */
export function grokVideoJobParams(settings, { sourceImagePath = null, durationSeconds, width, height } = {}) {
  const grok = settings?.imageGen?.grok || {};
  return {
    mode: VIDEO_GEN_MODE.GROK,
    videoMode: sourceImagePath ? 'image' : 'text',
    grokPath: grok.grokPath,
    duration: nearestGrokDuration(durationSeconds),
    ...(Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {}),
    ...(grok.aspectRatio ? { aspectRatio: grok.aspectRatio } : {}),
  };
}

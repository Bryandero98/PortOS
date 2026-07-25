/**
 * Sprites — per-track animation targets (issue #2985).
 *
 * A walk cycle occupies N contiguous atlas columns × 8 direction rows, so every
 * direction in ONE set must share a frame count and a playback fps — the atlas
 * is a rectangular grid and a ragged set cannot compile. That invariant used to
 * surface only at compile time (atlas.js), after eight renders and eight
 * approvals were already spent. This module makes the target explicit and
 * resolvable up front so it can be enforced when each render is QUEUED.
 *
 * The target is **track-keyed**, never record-level: uniformity is a property of
 * one animation track, not of a character. A future portable-scanner action
 * (4 frames) or an ambient loop (3 frames) legitimately differs from the walk,
 * so the persisted shape is
 *
 *   "animationTargets": { "walk": { "frameCount": 12, "fps": 10, "source": "set" } }
 *
 * and an unrecognized sibling track key MUST round-trip untouched (see
 * `withTrackTarget`) — adding a track later is additive, not a reshape. Packing
 * tracks of DIFFERING lengths into one atlas needs a column-span descriptor and
 * is deliberately out of scope here.
 *
 * Dependency-free apart from the sharp-free `animationTracks` registry, so the
 * service layer and the (native-dep-free) validation graph can both reach it.
 *
 * Since #3015 the bounds this module range-checks against come from that
 * registry PER TRACK, not from one global walk-shaped range — so a future
 * 4-frame scanner action resolves against its own row instead of being rejected
 * by walk's floor of 6.
 */

import {
  WALK_TRACK, getAnimationTrack,
} from './animationTracks.js';

// Re-exported so existing importers (walk.js) keep reaching the walk track id
// here; the registry owns the value now, so the two can never disagree.
export { WALK_TRACK };

const intInRange = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
// Range readers bound to ONE track's row. Out-of-range values read as `null`
// (absent) rather than being clamped — see resolveAnimationTarget's contract.
const trackReaders = (row) => ({
  readFrameCount: (v) => intInRange(v, row.minFrameCount, row.maxFrameCount),
  readFps: (v) => intInRange(v, row.minFps, row.maxFps),
});

/**
 * Resolve one track's pinned target from the precedence chain, newest authority
 * first. `source` names the winning rung so the UI can explain itself instead of
 * re-deriving the precedence:
 *
 *   'app'     — the bound app's `runtimeContract` (#2982). The app decides what
 *               its atlas may hold, so this cannot be overridden per render.
 *   'set'     — an explicit `animationTargets.<track>` the user pinned.
 *   'derived' — the first packaged direction's geometry (the same first-wins
 *               rule atlas.js already applies), auto-pinned on first resolve so
 *               it stops being implicit. Persisted with `source: 'derived'` so a
 *               value PortOS inferred never masquerades as one the user chose.
 *   'default' — the track's `defaultFrameCount` / `defaultFps`.
 *
 * Out-of-range or non-integer values at any rung are ignored rather than
 * clamped: a hand-edited record must not silently pin a value the packer would
 * quietly rewrite. Each knob falls through independently (an app that pins only
 * the frame count still takes its fps from the set/derived/default rungs), but
 * `source` names the highest rung that supplied EITHER knob, and
 * `frameCountLocked` / `fpsLocked` say precisely which the app nailed down.
 *
 * `track` selects which persisted entry to read AND which registry row supplies
 * the bounds, the defaults, and the `runtimeContract` field names — all three
 * were walk-specific before #3015. An absent track resolves to `walk`
 * (preserving every existing call site); an UNRECOGNIZED one throws rather than
 * silently validating against walk's range.
 *
 * @param {object}   input
 * @param {string}   [input.track]            Track id from `animationTracks.js` (default 'walk').
 * @param {object}   [input.runtimeContract]  `publishBinding.runtimeContract`, if any.
 * @param {object}   [input.animationTargets] The selection record's block.
 * @param {Array<{direction?: string, frameCount?: number, fps?: number}>} [input.packagedCycles]
 *        Packaged directions in atlas order — first entry with a usable value wins.
 * @returns {{track: string, frameCount: number, fps: number, source: string,
 *            frameCountLocked: boolean, fpsLocked: boolean}}
 */
export function resolveAnimationTarget({
  track = WALK_TRACK,
  runtimeContract = null,
  animationTargets = null,
  packagedCycles = [],
} = {}) {
  // Throws on an unrecognized track — an explicit error beats silently
  // range-checking a scanner action against the walk's 6–16.
  const row = getAnimationTrack(track);
  const { readFrameCount, readFps } = trackReaders(row);

  // The bound app's declared expectation for its own atlas (#2982) — a stronger
  // authority than any per-render pick. Read defensively: that field lands
  // independently of this module, so an absent contract just falls through.
  const appCount = readFrameCount(runtimeContract?.[row.contractFrameCountField]);
  const appFps = readFps(runtimeContract?.[row.contractFpsField]);

  const pinned = animationTargets?.[row.id] || null;
  const setCount = readFrameCount(pinned?.frameCount);
  const setFps = readFps(pinned?.fps);

  const derivedCount = firstDefined(packagedCycles, (c) => readFrameCount(c?.frameCount));
  const derivedFps = firstDefined(packagedCycles, (c) => readFps(c?.fps));

  let source = 'default';
  if (derivedCount !== null || derivedFps !== null) source = 'derived';
  // A block PortOS auto-pinned from the set carries `source: 'derived'`; anything
  // else (including a legacy block written before this field existed) is a
  // deliberate user pin and reports as 'set'.
  if (setCount !== null || setFps !== null) source = pinned?.source === 'derived' ? 'derived' : 'set';
  if (appCount !== null || appFps !== null) source = 'app';

  return {
    track: row.id,
    frameCount: appCount ?? setCount ?? derivedCount ?? row.defaultFrameCount,
    fps: appFps ?? setFps ?? derivedFps ?? row.defaultFps,
    source,
    frameCountLocked: appCount !== null,
    fpsLocked: appFps !== null,
  };
}

function firstDefined(list, read) {
  for (const item of list || []) {
    const value = read(item);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Merge one track's target into an existing `animationTargets` map WITHOUT
 * disturbing sibling tracks. Load-bearing forward-compatibility: a peer (or a
 * later PortOS) may have written a `scanner` / ambient entry this build knows
 * nothing about, and a naive `{ walk: … }` overwrite would silently drop it.
 *
 * The track being WRITTEN must be one this build knows (#3015) — an unrecognized
 * write target is a bug, not a forward-compat case, and would persist a row
 * nothing can range-check. Sibling keys are untouched either way: preserving
 * what a newer peer wrote and writing a bogus key are different things.
 */
export function withTrackTarget(animationTargets, track, { frameCount, fps, source }) {
  const row = getAnimationTrack(track);
  const existing = (animationTargets && typeof animationTargets === 'object' && !Array.isArray(animationTargets))
    ? animationTargets
    : {};
  return { ...existing, [row.id]: { frameCount, fps, source } };
}

/**
 * Packaged directions whose geometry disagrees with the resolved target — the
 * set is compilable only when this is empty. Reported per direction so the UI
 * can badge exactly which ones need re-deriving, instead of the user discovering
 * it at atlas-compile time. A cycle with no usable geometry (an import that
 * never declared one) is not "drift" — there is nothing to compare.
 *
 * Range-checks each cycle against the TARGET's own track (#3015), falling back
 * to the default track when the caller passed a bare `{ frameCount, fps }`.
 */
export function targetDrift(target, packagedCycles = []) {
  const { readFrameCount, readFps } = trackReaders(getAnimationTrack(target?.track));
  return (packagedCycles || []).flatMap((cycle) => {
    const frameCount = readFrameCount(cycle?.frameCount);
    const fps = readFps(cycle?.fps);
    if (frameCount === null && fps === null) return [];
    const countDrifts = frameCount !== null && frameCount !== target.frameCount;
    const fpsDrifts = fps !== null && fps !== target.fps;
    if (!countDrifts && !fpsDrifts) return [];
    return [{
      direction: cycle.direction, frameCount, fps, frameCountDrifts: countDrifts, fpsDrifts,
    }];
  });
}

/**
 * Human-readable provenance, shared by the 409 message and the UI label so the
 * two can never describe the same target differently.
 */
export function describeTargetSource(target, appName = null) {
  switch (target.source) {
    case 'app': return `locked by ${appName || 'the bound app'}`;
    case 'set': return 'set target';
    case 'derived': return 'from the first approved direction';
    default: return 'default';
  }
}

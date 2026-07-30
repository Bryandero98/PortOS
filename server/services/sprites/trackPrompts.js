/**
 * Per-track image-to-video prompt resolution (#3136, #3152).
 *
 * The generic animation workflow needs ONE call that answers "what do I send the
 * provider for this track?" — because that question was the last thing that was
 * still track-specific code rather than track-specific data. #3152 made it fully
 * data: a track resolves through the compiled builder when it is the built-in
 * `walk`, and through its own stored `promptTemplate` when it came from the
 * user-defined store. A genuinely unknown id — neither compiled nor stored — still
 * throws, which is the same unknown-id boundary `getAnimationTrack` draws and for
 * the same reason: a mis-keyed track that silently sent the walk prompt would
 * render a gait loop and pass every later check, since nothing downstream re-reads
 * what was asked for.
 *
 * **Exactly one prompt source per track, never two.** The dispatch below keys on
 * `row.builtin` rather than trying the compiled table first and the template
 * second. A precedence chain would leave `scanner` with two definitions of its
 * wording — the compiled `buildScannerPrompt` and the seeded template — and the
 * seed is the one a user edits, so the edit would silently do nothing. Instead the
 * seeded rows resolve through their templates, and `trackPrompts.test.js` pins
 * those templates byte-for-byte against the compiled builders that produced them,
 * so the migration is provably a no-op on the wire. The compiled
 * `buildScannerPrompt`/`buildAmbientVideoPrompt` stay exported from `prompts.js` as
 * that pinned reference (and for `prompts.test.js`'s wording assertions), not as a
 * live fallback.
 *
 * Kept separate from `prompts.js` deliberately: that module is the pure catalog of
 * prompt TEXT (and its tests assert the exact wording of each stage), while this is
 * the small dispatch layer over it. Folding the dispatch in would make every
 * prompt-wording test also a routing test.
 *
 * Pure apart from the store read the effective registry performs (a cached
 * `readFileSync` of one small config — see `animationTrackStore.js`).
 */

import { buildWalkVideoPrompt, applyCorrection, keyColorPhrase } from './prompts.js';
import { WALK_TRACK } from './animationTracks.js';
import { getEffectiveAnimationTracks } from './animationTrackStore.js';

/**
 * The i2v prompt builder for each track compiled into this build — `walk` alone
 * since #3152 moved `scanner` and `ambient` into the store as seed data.
 *
 * Every builder takes the same superset argument object and reads only what it
 * needs, so the dispatch below passes one shape and never has to know which
 * fields a given track's wording happens to embed.
 */
const TRACK_VIDEO_PROMPTS = Object.freeze({
  [WALK_TRACK]: buildWalkVideoPrompt,
});

/**
 * The placeholders a stored `promptTemplate` may interpolate.
 *
 * `chromaKey` is the raw hex and `chromaKeyPhrase` is the named form
 * ("magenta (#FF00FF)") — BOTH, because the two seeded templates disagree: the
 * scanner wording embeds the bare hex and the ambient wording embeds the phrase,
 * and collapsing them to one variable would change one of the two prompts on the
 * wire. A user's template picks whichever reads better in its sentence.
 *
 * `correctionPrompt` is deliberately NOT a placeholder: every builder wraps its
 * body with `applyCorrection`, which frames the render as a correction up front
 * and closes with the override clause. Reading as an override of the base wording
 * is the whole contract — a template that interpolated it mid-sentence would bury
 * it, which is precisely the failure mode #3216 fixed.
 */
const templateVariables = ({ name, kind, direction, chromaKey }) => ({
  name: name ?? '',
  kind: kind ?? '',
  direction: direction ?? '',
  chromaKey: chromaKey ?? '',
  chromaKeyPhrase: keyColorPhrase(chromaKey),
});

/**
 * Interpolate `{{variable}}` placeholders in a stored template.
 *
 * An UNKNOWN placeholder is left literal rather than replaced with an empty
 * string: the user authored it, the prompt is shown back to them (the sprite asset
 * preview rebuilds provenance through this same call), and a visible `{{drection}}`
 * is a typo they can find and fix, where a silently-dropped clause reads as the
 * model ignoring their instruction. Whitespace inside the braces is tolerated.
 */
export function renderPromptTemplate(template, args) {
  const vars = templateVariables(args || {});
  return String(template).replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  ));
}

/**
 * The image-to-video instruction for one track's render.
 *
 * Throws on a track the effective registry doesn't know — see the header.
 */
export function buildTrackVideoPrompt(trackId, args) {
  const tracks = getEffectiveAnimationTracks();
  const row = tracks[trackId];
  if (!row) {
    throw new Error(
      `No image-to-video prompt is registered for animation track '${String(trackId)}' `
      + `— known tracks: ${Object.keys(tracks).join(', ')}.`,
    );
  }
  if (!row.builtin) {
    return applyCorrection(
      renderPromptTemplate(row.promptTemplate, args),
      args?.correctionPrompt,
      'source image',
    );
  }
  const build = TRACK_VIDEO_PROMPTS[trackId];
  // A builtin row with no compiled builder is unreachable today (`walk` is the
  // only one) but would otherwise fall through as `undefined(args)` — report the
  // registry/code mismatch by name instead.
  if (!build) {
    throw new Error(`Builtin animation track '${String(trackId)}' has no compiled image-to-video prompt builder.`);
  }
  return build(args);
}

/**
 * The i2v prompt for `trackId`, or `null` when this build cannot produce one.
 *
 * For the provenance rebuild in `assetPrompt.js`, whose question is "rebuild this
 * run's prompt if you still can" — a run may name a track a newer peer wrote, or
 * one whose row the user has since deleted. A separate `hasTrackVideoPrompt`
 * predicate used to answer the first half, which meant duplicating
 * `buildTrackVideoPrompt`'s own resolution branch and keeping the two in step; this
 * asks the one resolver and turns its unknown-track throw into the `null` the
 * caller wanted. It does NOT swallow anything else — a malformed template or a
 * builtin/builder mismatch still throws.
 */
export function tryBuildTrackVideoPrompt(trackId, args) {
  if (!getEffectiveAnimationTracks()[trackId]) return null;
  return buildTrackVideoPrompt(trackId, args);
}

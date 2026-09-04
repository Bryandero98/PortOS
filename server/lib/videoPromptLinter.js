/**
 * Deterministic lint pass for continuous-video clip prompts (part of #6217's
 * chained-generation feature). Catches the prompt patterns that cause visual
 * smear/collapse when a video model chains one clip onto the next: a missing
 * hard-cut opener, a re-used camera framing, a paraphrased bible descriptor,
 * or language that reads fine in prose but breaks a video prompt — referring
 * back to "the same" shot, negating something, or naming on-screen text.
 *
 * Pure text analysis — no I/O, no video-backend awareness. Independent of
 * `scriptVideoCompiler.js` (#6225) by interface: it lints already-built clip
 * prompt strings plus caller-supplied framing/reference metadata, not a
 * compiler-shaped clip object. `continuousVideo.js` (#6227) composes this
 * with the compiler's output.
 *
 * Returns structured per-clip results rather than throwing — callers decide
 * how to surface a failing lint (block submission, warn, retry the prompt).
 */

import { resolveBibleDescriptor } from './scriptVideoCompiler.js';

export const MAX_CLIP_PROMPT_LENGTH = 800;

const BANNED_REFERENTS = ['same', 'still', 'again', 'continues', 'as before'];
const BANNED_NEGATIVES = ['no', 'without', 'never'];
const BANNED_OVERLAY_TERMS = ['text', 'caption', 'overlay'];

const wordBoundaryRegex = (phrase) => new RegExp(`(?:^|[^a-z0-9])${phrase.replace(/\s+/g, '\\s+')}(?:$|[^a-z0-9])`, 'i');

const findBannedTerms = (prompt, terms) => terms.filter((term) => wordBoundaryRegex(term).test(prompt));

/**
 * Lint a single clip prompt against every rule.
 *
 * @param {object} clip
 * @param {string} clip.prompt
 * @param {'fresh'|'continue'} clip.cutType
 * @param {string} [clip.framing] - this clip's camera framing/angle, required to check the hard-cut opener on a 'continue' clip
 * @param {string} [clip.previousFraming] - the preceding chained clip's framing/angle, checked only when cutType === 'continue'
 * @param {Array<{kind: 'cast'|'locations', id: string}>} [clip.references] - bible entries this clip's prompt must carry verbatim
 * @param {object} [options]
 * @param {object} [options.bible]
 * @param {number} [options.maxLength]
 * @returns {{pass: boolean, reasons: string[]}}
 */
export function lintClipPrompt(clip, { bible, maxLength = MAX_CLIP_PROMPT_LENGTH } = {}) {
  const { prompt = '', cutType, framing, previousFraming, references = [] } = clip || {};
  const reasons = [];

  if (cutType === 'continue') {
    const opener = framing ? `Hard cut to ${framing}:` : null;
    if (!opener || !prompt.trimStart().startsWith(opener)) {
      reasons.push(opener
        ? `missing hard-cut opener "${opener}"`
        : 'missing hard-cut opener: clip.framing was not provided');
    }
    if (framing && previousFraming && framing.trim().toLowerCase() === previousFraming.trim().toLowerCase()) {
      reasons.push(`framing "${framing}" repeats the preceding clip's framing — a continuing clip needs a distinct camera framing/angle`);
    }
  }

  for (const ref of references) {
    const descriptor = resolveBibleDescriptor(bible, ref?.kind, ref?.id);
    if (!descriptor) {
      reasons.push(`no bible descriptor found for ${ref?.kind}/${ref?.id}`);
    } else if (!prompt.includes(descriptor)) {
      reasons.push(`prompt is missing the verbatim bible descriptor for ${ref.kind}/${ref.id}`);
    }
  }

  for (const term of findBannedTerms(prompt, BANNED_REFERENTS)) {
    reasons.push(`banned cross-clip referent "${term}" — describe what is visible in THIS clip instead of referring back to a previous one`);
  }
  for (const term of findBannedTerms(prompt, BANNED_NEGATIVES)) {
    reasons.push(`banned negative construction "${term}" — video models tend to render negated content instead of omitting it`);
  }
  for (const term of findBannedTerms(prompt, BANNED_OVERLAY_TERMS)) {
    reasons.push(`banned UI overlay language "${term}" — video models tend to render literal on-screen text/captions from this`);
  }

  if (prompt.length > maxLength) {
    reasons.push(`prompt is ${prompt.length} characters, over the ${maxLength} character limit`);
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Lint an ordered array of clips (chain order, same as
 * `scriptVideoCompiler.compileScriptToClips` emits them). Each clip's
 * `previousFraming` defaults to the preceding array element's `framing` when
 * not set explicitly.
 *
 * @returns {{pass: boolean, results: Array<{index: number, pass: boolean, reasons: string[]}>}}
 */
export function lintClips(clips, { bible, maxLength = MAX_CLIP_PROMPT_LENGTH } = {}) {
  const results = (clips || []).map((clip, index) => {
    const previousFraming = clip?.previousFraming ?? clips[index - 1]?.framing ?? null;
    return { index, ...lintClipPrompt({ ...clip, previousFraming }, { bible, maxLength }) };
  });
  return { pass: results.every((r) => r.pass), results };
}

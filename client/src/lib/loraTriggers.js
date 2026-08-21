/**
 * Client mirror of the trigger-word predicates in `server/lib/loraTriggers.js`
 * (issue #4665).
 *
 * The server is the enforcement point — it weaves each selected LoRA's first
 * activation token into the prompt at render time. These two helpers exist so
 * the UI can say the same thing the server will do: which token is missing, and
 * whether a word is already doing its job in the prompt. Keep the matching rules
 * identical to the server module or the picker's hint will contradict the render.
 */

// Only the FIRST trigger word of a LoRA activates it, per the server weave —
// Civitai `trainedWords` routinely lists a dozen loosely-related tags.
export const firstTriggerWord = (words) => {
  if (!Array.isArray(words)) return null;
  const first = words.find((w) => typeof w === 'string' && w.trim());
  return first ? first.trim() : null;
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const WORD_CHAR = /[A-Za-z0-9_]/;

// Whole-token, case-insensitive presence test, applied anywhere in the prompt
// (Civitai triggers are commonly woven mid-sentence). Boundaries are asserted
// only where the trigger's own edge is a word character, so `aria_tok` does not
// match inside `aria_token` while a punctuation-edged trigger still matches.
export const promptHasTriggerWord = (prompt, word) => {
  const text = typeof prompt === 'string' ? prompt : '';
  const token = typeof word === 'string' ? word.trim() : '';
  if (!text || !token) return false;
  const lead = WORD_CHAR.test(token[0]) ? '(?<![A-Za-z0-9_])' : '';
  const tail = WORD_CHAR.test(token[token.length - 1]) ? '(?![A-Za-z0-9_])' : '';
  return new RegExp(`${lead}${escapeRegExp(token)}${tail}`, 'i').test(text);
};

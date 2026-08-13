/**
 * "Is this bible entry actually described?" — the one field vocabulary the
 * describe automation, the character/canon expand services, and the image jobs
 * all measure completeness against.
 *
 * A universe bible entry can be *present* without being *usable*: a character
 * row with a name and nothing else renders a generic figure, and a place with a
 * blank description renders whatever the model felt like. The quota-burn
 * describe job exists to close that gap before any image quota is spent on it,
 * which needs a definition of "described" that does not live in the job.
 *
 * Two depths, because the two questions are different:
 *   - `core`   — the minimum for the entry to render or be written at all.
 *   - `full`   — the whole sheet: everything the expand prompts can fill, which
 *                for a character is the character-sheet field set a novelist +
 *                graphic novelist both need.
 *
 * Pure module: shape and predicates only, no storage and no provider I/O, so the
 * burn job (which must not import the universe store to answer "how many are
 * missing"), the expand services, and the tests all agree on one list. The
 * character lists are the SOURCE for `universeCharacterExpand.js`'s
 * `STRING_FIELDS` / `LIST_FIELDS` — a field the expand prompt fills but this
 * module doesn't know about would be permanently invisible to the completeness
 * scan, so the two are deliberately one list rather than two that agree today.
 */

/** Depth vocabulary. `core` = renderable at all; `full` = the whole sheet. */
export const BIBLE_DESCRIBE_DEPTHS = Object.freeze(['core', 'full']);

/** The three slider axes, all of which must be rated for `sliders` to count as filled. */
const SLIDER_AXES = Object.freeze(['proactivity', 'likability', 'competence']);

/**
 * Every field the per-kind expand prompt may fill, grouped by how it is stored.
 * The grouping is what lets one merge helper handle all three kinds:
 *   - `strings` — plain prose, blank when empty/whitespace
 *   - `lists`   — arrays of sanitized rows, blank when empty
 *   - `enums`   — a single constrained token, blank when unset (null)
 *   - `objects` — structured records with their own "is it filled" rule
 */
export const BIBLE_EXPAND_FIELDS = Object.freeze({
  character: Object.freeze({
    strings: Object.freeze([
      'pronouns', 'age', 'coreTheme', 'speechAccent', 'speechPattern',
      'physicalDescription', 'personality', 'background', 'visualNotes',
      'silhouetteNotes', 'postureNotes', 'specialTraits', 'visualIdentity',
      'motivations', 'likes', 'dislikes', 'mannerisms', 'relationships', 'skills',
      // Character framework (CWQE Phase 10, #2175) — the Ghost → Wound → Lie →
      // Want → Need chain. `arcType` and `sliders` are the structured half.
      'ghost', 'wound', 'lie', 'want', 'need',
    ]),
    lists: Object.freeze([
      'stats', 'colorPalette', 'props', 'expressions', 'handGestures',
      'wardrobes', 'secrets',
    ]),
    enums: Object.freeze(['arcType']),
    objects: Object.freeze(['sliders']),
  }),
  place: Object.freeze({
    strings: Object.freeze(['description', 'palette', 'era', 'weather', 'recurringDetails']),
    lists: Object.freeze([]),
    enums: Object.freeze(['intExt', 'timeOfDay']),
    objects: Object.freeze([]),
  }),
  object: Object.freeze({
    strings: Object.freeze(['description', 'significance']),
    lists: Object.freeze([]),
    enums: Object.freeze([]),
    objects: Object.freeze([]),
  }),
});

/**
 * The `core` set per kind — what an entry needs before it is worth rendering.
 *
 * Deliberately short. `core` gates the image job's opt-in "skip entries nobody
 * has described yet" filter, and a long core list there would park most of a
 * young universe's backlog behind an LLM pass the user may not want.
 */
export const BIBLE_CORE_FIELDS = Object.freeze({
  character: Object.freeze(['physicalDescription', 'personality', 'background', 'motivations', 'visualNotes']),
  place: Object.freeze(['description']),
  object: Object.freeze(['description']),
});

/** Canon kinds this module knows how to measure. Mirrors `storyBible.BIBLE_KINDS`. */
export const BIBLE_DESCRIBE_KINDS = Object.freeze(Object.keys(BIBLE_EXPAND_FIELDS));

/**
 * `relationshipLinks` (characters) and `attachments` (objects) are INTENTIONALLY
 * absent from every list above: each row points at a sibling entry by id, which
 * an expand call has no way to mint. They are authored in the UI, so counting
 * them as "missing" would make every entry permanently incomplete.
 */

const requiredFields = (kind, depth) => {
  const groups = BIBLE_EXPAND_FIELDS[kind];
  if (!groups) return [];
  if (depth === 'core') return BIBLE_CORE_FIELDS[kind] || [];
  return [...groups.strings, ...groups.lists, ...groups.enums, ...groups.objects];
};

/**
 * A character's canonical description lives in `physicalDescription`; migration
 * 019 rewrites the legacy `description` alias forward but the read-side fallback
 * stays, so a pre-migration entry must not read as blank here (it would be
 * re-described on top of text it already has).
 */
const FIELD_VALUE = Object.freeze({
  physicalDescription: (entry) => entry?.physicalDescription || entry?.description || '',
});

/**
 * Per-field "is this still blank" overrides. Everything else falls through to
 * the string/array rule below: `sliders` is an always-present object whose axes
 * are individually null until rated, so plain presence would report it filled
 * the moment the sanitizer materialized it.
 */
const FIELD_IS_BLANK = Object.freeze({
  sliders: (value) => !value || typeof value !== 'object' || SLIDER_AXES.some((axis) => value[axis] == null),
});

const isBlankValue = (value) => (Array.isArray(value)
  ? value.length === 0
  : (typeof value !== 'string' || value.trim() === ''));

/** Whether ONE field on an entry is still unfilled. Exported for the expand merges. */
export function bibleFieldIsBlank(entry, field) {
  const value = FIELD_VALUE[field] ? FIELD_VALUE[field](entry) : entry?.[field];
  return (FIELD_IS_BLANK[field] || isBlankValue)(value);
}

/** Normalize an untrusted depth param to a known depth, defaulting to `full`. */
export const normalizeDescribeDepth = (depth) =>
  (BIBLE_DESCRIBE_DEPTHS.includes(depth) ? depth : 'full');

/**
 * The fields still blank on `entry`, in the canonical order the expand prompt
 * lists them. Empty array means the entry is described to that depth.
 */
export function missingBibleFields(kind, entry, { depth = 'full' } = {}) {
  if (!entry || typeof entry !== 'object') return [];
  return requiredFields(kind, normalizeDescribeDepth(depth)).filter((field) => bibleFieldIsBlank(entry, field));
}

/** Whether `entry` has every field the depth asks for. */
export const bibleEntryIsDescribed = (kind, entry, options) =>
  missingBibleFields(kind, entry, options).length === 0;

/**
 * Completeness as a ratio plus the gap list — what the describe job reports and
 * what orders its picks (the emptiest entries first, so a capped run spends its
 * budget where it buys the most).
 */
export function bibleEntryCompleteness(kind, entry, { depth = 'full' } = {}) {
  const required = requiredFields(kind, normalizeDescribeDepth(depth));
  const missing = missingBibleFields(kind, entry, { depth });
  return {
    required: required.length,
    missing,
    filled: required.length - missing.length,
    complete: missing.length === 0,
  };
}

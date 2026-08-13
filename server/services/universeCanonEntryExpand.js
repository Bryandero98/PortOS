/**
 * Universe Place / Object — LLM expansion.
 *
 * The non-character half of `universeCharacterExpand.js`: one LLM call that
 * fleshes out blank fields on a canon place or object without clobbering
 * populated content. Characters keep their own module because their prompt
 * carries the whole character-sheet contract (stats, palette, expressions,
 * props, the Ghost→Need chain) and a peer-distinctness pass; places and objects
 * share a much smaller field set and one template.
 *
 * Same strict "fill blanks only" semantics as the character expand:
 *   - key absent from LLM response → preserve existing value
 *   - key present with an empty value → IGNORED (no "clear" intent exists in an
 *     expand flow — an empty proposal just means the model had nothing to add)
 *   - key present with a non-empty value → fill ONLY when the target is blank
 *
 * Locked entries are never touched, checked both before the call and again
 * inside the write queue (a lock can land during the LLM round-trip).
 */

import { getUniverse, updateUniverse } from './universeBuilder.js';
import { buildStyleClause } from './universeCanon.js';
import { runPromptRefineRaw } from './pipeline/refineHelpers.js';
import { ServerError } from '../lib/errorHandler.js';
import { BIBLE_FIELD, BIBLE_KIND, SANITIZERS } from '../lib/storyBible.js';
import { BIBLE_EXPAND_FIELDS, bibleFieldIsBlank } from '../lib/universeBibleCompleteness.js';
import { shortId } from '../lib/fileUtils.js';

/** Kinds this module expands. Characters route to `universeCharacterExpand.js`. */
export const CANON_ENTRY_EXPAND_KINDS = Object.freeze([BIBLE_KIND.PLACE, BIBLE_KIND.OBJECT]);

// Peers exist so the model doesn't hand three taverns the same palette. Kept
// deliberately thin — a place's own description is the only field that matters
// for collision, and sending the full records would blow the prompt up on a
// universe with a hundred locations.
const peerForExpandPrompt = (entry) => ({
  id: entry.id,
  name: entry.name || entry.slugline || '',
  description: entry.description || '',
});

/**
 * Pure no-clobber merge of an LLM payload onto a place/object. Exported so the
 * merge semantics can be exercised without an LLM round-trip.
 *
 * Every accepted value round-trips through the kind's sanitizer before it is
 * recorded: an out-of-vocabulary enum (`intExt: "INTERIOR"`) collapses to null
 * there, and accepting the raw proposal would report a field as filled that the
 * next persist silently drops.
 */
export function applyCanonEntryExpansion(kind, target, content) {
  const groups = BIBLE_EXPAND_FIELDS[kind];
  const sanitize = SANITIZERS[kind];
  if (!groups || !sanitize || !target || typeof target !== 'object' || !content || typeof content !== 'object') {
    return { merged: target, updatedFields: [] };
  }
  const merged = { ...target };
  const updatedFields = [];
  for (const field of [...groups.strings, ...groups.enums]) {
    if (!(field in content)) continue;
    const proposed = content[field];
    if (typeof proposed !== 'string' || !proposed.trim()) continue;
    if (!bibleFieldIsBlank(target, field)) continue;
    // `name`/`slugline` carry the record past the sanitizer's identity check —
    // a place needs one of them or `sanitizePlace` returns null and every
    // proposal would be discarded as unsanitizable.
    const cleaned = sanitize(
      { name: target.name, slugline: target.slugline, [field]: proposed },
      { preserveTimestamps: false },
    )?.[field];
    if (typeof cleaned !== 'string' || !cleaned.trim()) continue;
    merged[field] = cleaned;
    updatedFields.push(field);
  }
  return { merged, updatedFields };
}

/**
 * Fill blank fields on one canon place or object.
 *
 * Returns `{ universe, entry, updatedFields, locked? }` — `locked: true` with no
 * updated fields when the entry was (or became) locked, mirroring
 * `expandUniverseCharacter` so a caller can treat the two identically.
 */
export async function expandUniverseCanonEntry(universeId, kind, entryId, options = {}) {
  if (!CANON_ENTRY_EXPAND_KINDS.includes(kind)) {
    throw new ServerError(`Canon kind ${kind} is not expandable here`, {
      status: 400, code: 'UNIVERSE_CANON_KIND_UNSUPPORTED',
    });
  }
  const field = BIBLE_FIELD[kind];
  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe[field]) ? universe[field] : [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) {
    throw new ServerError(`${kind} ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  const target = list[idx];
  if (target.locked === true) {
    return { universe, entry: target, locked: true, updatedFields: [] };
  }

  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName: 'universe-canon-entry-expand',
    variables: {
      kind,
      styleClause: buildStyleClause(universe),
      entryJson: JSON.stringify(target),
      peersJson: JSON.stringify(list.filter((_, i) => i !== idx).map(peerForExpandPrompt)),
    },
    options: { providerId: options.providerId, model: options.model },
    source: 'universe-canon-entry-expand',
    logTag: null,
    emptyError: {
      code: 'UNIVERSE_CANON_ENTRY_EXPAND_EMPTY',
      message: `LLM returned an empty ${kind} expansion`,
    },
  });

  // Re-derive the merge INSIDE the write queue against the freshest persisted
  // universe so a user edit that landed during the LLM round-trip isn't
  // overwritten. The mutator returns null to skip the write when nothing changed.
  let updatedFields = [];
  let lockedDuringRender = false;
  const updated = await updateUniverse(universeId, (latest) => {
    const latestList = Array.isArray(latest[field]) ? latest[field] : [];
    const latestIdx = latestList.findIndex((e) => e.id === entryId);
    if (latestIdx < 0) return null;
    if (latestList[latestIdx].locked === true) {
      lockedDuringRender = true;
      return null;
    }
    const { merged, updatedFields: fields } = applyCanonEntryExpansion(kind, latestList[latestIdx], content);
    updatedFields = fields;
    if (fields.length === 0) return null;
    return { [field]: latestList.map((e, i) => (i === latestIdx ? merged : e)) };
  });

  const latestEntry = (updated?.[field] || []).find((e) => e.id === entryId) || target;
  if (lockedDuringRender) {
    return { universe: updated, entry: latestEntry, locked: true, updatedFields: [], rationale, runId, providerId, model };
  }
  if (updatedFields.length > 0) {
    console.log(`✨ Universe ${kind} expand — universe=${shortId(universeId)} entry=${shortId(entryId)} fields=${updatedFields.length} runId=${shortId(runId)}`);
  }
  return { universe: updated, entry: latestEntry, rationale, runId, providerId, model, updatedFields };
}

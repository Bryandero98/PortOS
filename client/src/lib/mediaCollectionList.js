// Search / sort / hide-empty helpers for the Media Collections grid (#3283).
//
// The grid is dominated by collections nothing created on purpose: every
// Creative Director project and every universe/series render bucket auto-files
// itself as a collection, so a user with a handful of real collections scrolls
// past dozens of empty auto-generated ones to find them. These helpers give the
// page one definition of "auto-generated", "empty", and the display ordering
// that keeps real collections on top.
//
// Pure — no React, no I/O. The page and its tests share them.

// Shared name prefixes that auto-creators stamp onto every collection they
// make. Rendered as a badge above the card title instead of inside it, so the
// distinguishing tail (usually a project name + date) isn't what gets clipped.
// Keep in sync with the server-side creators
// (`server/services/creativeDirector/projects{DB,File}.js`).
export const AUTO_NAME_PREFIXES = ['Creative Director: '];

// Description stamped by the auto-creators. A user can't produce this by
// accident through the UI (the create form takes a name only).
const AUTO_DESCRIPTION_PREFIX = 'Auto-created for project ';

// Deterministic id prefixes for the universe-/series-linked render buckets the
// pipeline files into (see `mediaCollections.js` — `uc-<universeId>` /
// `sc-<seriesId>`).
const AUTO_ID_PREFIXES = ['uc-', 'sc-'];

/**
 * Split a collection name into its auto-creator prefix and the remaining
 * title. Returns `{ badge: null, title: name }` for a user-named collection.
 * @param {string} name
 * @returns {{ badge: string|null, title: string }}
 */
export function splitCollectionName(name) {
  const str = typeof name === 'string' ? name : '';
  for (const prefix of AUTO_NAME_PREFIXES) {
    if (str.startsWith(prefix) && str.length > prefix.length) {
      // Trim the trailing separator off the badge label ("Creative Director").
      return { badge: prefix.replace(/[:\s]+$/, ''), title: str.slice(prefix.length) };
    }
  }
  return { badge: null, title: str };
}

/**
 * True when a collection was created by an automated flow rather than by the
 * user. Any one of the four independent markers is sufficient — an install can
 * hold records from before a given marker existed, so this must not require all
 * of them to agree.
 * @param {object} collection
 * @returns {boolean}
 */
export function isAutoCollection(collection) {
  if (!collection || collection.synthetic) return false;
  if (splitCollectionName(collection.name).badge) return true;
  const description = typeof collection.description === 'string' ? collection.description : '';
  if (description.startsWith(AUTO_DESCRIPTION_PREFIX)) return true;
  const id = typeof collection.id === 'string' ? collection.id : '';
  if (AUTO_ID_PREFIXES.some((p) => id.startsWith(p))) return true;
  return Boolean(collection.universeId || collection.seriesId);
}

/** Item count for a collection (0 for a malformed/absent items array). */
export function collectionItemCount(collection) {
  return Array.isArray(collection?.items) ? collection.items.length : 0;
}

// The sort control's options, in menu order. First entry is the default.
export const COLLECTION_SORTS = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'name', label: 'Name' },
  { id: 'count', label: 'Item count' },
];

export const DEFAULT_COLLECTION_SORT = COLLECTION_SORTS[0].id;

/** Coerce a stored/URL sort id to a known one (unknown → the default). */
export function normalizeCollectionSort(raw) {
  return COLLECTION_SORTS.some((s) => s.id === raw) ? raw : DEFAULT_COLLECTION_SORT;
}

// Ordering bucket: synthetic ("Unsorted") is pinned first, then anything with
// items or a user-chosen name, then the auto-generated empties that motivated
// this. Within a bucket the caller's sort applies.
const orderBucket = (collection) => {
  if (collection?.synthetic) return 0;
  if (collectionItemCount(collection) > 0) return 1;
  return isAutoCollection(collection) ? 2 : 1;
};

// Sort timestamp. `null`/absent means "never stamped" — distinct from a real
// epoch-0 date — and sorts last rather than pretending to be the oldest record.
const updatedTime = (collection) => {
  const raw = collection?.updatedAt || collection?.createdAt;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// Name sorting uses the PREFIX-STRIPPED title, so the Creative Director
// entries interleave by their real project names instead of all clumping under
// "C" — the same reason the prefix moves to a badge in the card.
const sortName = (collection) => splitCollectionName(collection?.name).title.toLowerCase();

const compareBy = (sort) => (a, b) => {
  if (sort === 'name') return sortName(a).localeCompare(sortName(b));
  if (sort === 'count') {
    const delta = collectionItemCount(b) - collectionItemCount(a);
    if (delta !== 0) return delta;
    return sortName(a).localeCompare(sortName(b));
  }
  const ta = updatedTime(a);
  const tb = updatedTime(b);
  if (ta === tb) return sortName(a).localeCompare(sortName(b));
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
};

// AND semantics across whitespace-separated tokens, matched against the name
// and description (substring, any order) — same shape as `mediaSearch.js`, but
// over collection records rather than normalized media items.
const matchesQuery = (collection, tokens) => {
  if (tokens.length === 0) return true;
  const haystack = `${collection?.name || ''} ${collection?.description || ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
};

/**
 * Filter + order the collection grid.
 * @param {object[]} collections - Enriched collections (synthetic entry included)
 * @param {object} view
 * @param {string} [view.query] - Free-text name/description search
 * @param {string} [view.sort] - One of COLLECTION_SORTS ids
 * @param {boolean} [view.hideEmpty] - Drop item-less collections
 * @returns {object[]} A new array; the input is not mutated
 */
export function applyCollectionView(collections, { query = '', sort = DEFAULT_COLLECTION_SORT, hideEmpty = false } = {}) {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = (collections || []).filter((c) => {
    if (hideEmpty && collectionItemCount(c) === 0) return false;
    return matchesQuery(c, tokens);
  });
  const comparator = compareBy(normalizeCollectionSort(sort));
  return filtered.sort((a, b) => (orderBucket(a) - orderBucket(b)) || comparator(a, b));
}

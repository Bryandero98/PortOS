/**
 * Sprites — authoring the user-defined animation-track store (#3153).
 *
 * #3152 made the track registry a merge of compiled `walk` plus a JSON store, and
 * #3136 made every track's generate/review/approve workflow generic — so a new
 * animation type already needs no code. What it still needed was a way to *author*
 * one: the store was a file the user had to hand-edit, which is not a feature so
 * much as a documented workaround. This module is the write half of that store.
 *
 * **Why a module of its own, not writers on `animationTrackStore.js`.** That module
 * is imported by `server/lib/validation.js` (which builds its sprite Zod ranges
 * from the effective registry at module load), and `animationTrackStore.test.js`
 * plus `animationTracks.test.js` pin how narrow its import graph is allowed to be —
 * `validation.js` must not drag the native image graph into request validation.
 * Refusing to delete a track that has authored work on disk means scanning every
 * record, which reaches `records.js` and the workflow's on-disk layout, i.e. sharp.
 * So reads stay in the leaf-ish store and writes live here, where the route layer
 * (which already imports `atlas.js`) is the only consumer.
 *
 * **Five row fields are DERIVED from the id, never typed.** `assertAnimationTrackRows`
 * refuses two rows claiming the same `contractFrameCountField`, `selectionKind`, or
 * `setKind`, and those strings name on-disk files and publish-contract keys — asking
 * a user to invent globally-unique `kind` discriminators is a trap with no upside,
 * and a typo in one would surface as another track's finalized set satisfying this
 * one's evidence check. The user types the id and the derivation is total. A derived
 * value that DOES collide (id `directional-scanner` derives the seeded scanner's
 * `reviewed-directional-scanner-selection`) is refused at save time by the same
 * assert, naming the conflict — which is the point of validating the merged table
 * here rather than discovering it at the next boot.
 *
 * `standaloneContract` is derived too, for the same reason: it is a cross-row
 * invariant (`assertAnimationTrackRows` requires exactly one standalone track per
 * record kind), so the only correct value depends on what else is in the table. A
 * new row is the baseline exactly when none of the kinds it claims already has one
 * — which is what makes "delete ambient, then add your own place loop" work. A row
 * spanning a kind that has a baseline and one that doesn't has no valid answer, and
 * the assert refuses it by naming the kind.
 *
 * **The writes are serialized and the cache is invalidated.** One `data/` file, one
 * `createFileWriteQueue` tail, so a create landing while a delete is mid-flight
 * cannot read a stale pre-image (the AGENTS.md rule for a service that owns a single
 * JSON state file). Every mutation ends in `__resetAnimationTrackStore()` so the
 * running server serves the table it just wrote instead of reporting success against
 * a cache nothing dropped.
 *
 * **A mutation still reports `restartRequired`.** Per #3136/#3152's scope the
 * registry itself is live after the cache reset, but `server/lib/validation.js`
 * builds `spriteRuntimeContractSchema`'s per-track contract fields ONCE at module
 * load — so a brand-new track's `<id>FrameCount` key is stripped by Zod until the
 * process restarts. Saying so in the response is the difference between a documented
 * boundary and a field that silently does nothing.
 */

import { atomicWrite, pathExists } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  WALK_TRACK, AUTHORED_TRACK_FIELDS, assertAnimationTrackRows, deriveTrackFields,
} from './animationTracks.js';
import {
  ANIMATION_TRACK_STORE_REL,
  ANIMATION_TRACK_STORE_SCHEMA_VERSION,
  animationTrackStorePath,
  getEffectiveAnimationTracks,
  __resetAnimationTrackStore,
} from './animationTrackStore.js';
import { recordsCarryingTrack } from './animationTrackWorkflow.js';

// One store file, so ONE tail — per AGENTS.md's "collapse the queue to a single
// tail per shared file". A per-id queue would let two different tracks' writes
// interleave on the same JSON and lose one of them.
const queueStoreWrite = createFileWriteQueue();

/** The stored (non-builtin) rows, in registration order. */
const storedRows = (tracks) => Object.values(tracks).filter((row) => !row.builtin);
/** The compiled-in rows (`walk`) — never mutable, always first in the merged table. */
const builtinRows = (tracks) => Object.values(tracks).filter((row) => row.builtin);

/**
 * Run a registry call whose failure is a bare `Error`, as a 409 the form can show.
 *
 * Both the store's load and `assertAnimationTrackRows` throw plain Errors — correct
 * for boot, where a loud crash naming the field is the whole point, but wrong on this
 * surface: here it is a *response* to a request the user made about that very file,
 * and an unrecognized error becomes an opaque 500 that says nothing about which row
 * is broken. The registry's messages already name the field, the two claimants, or
 * the record kind, so they are surfaced verbatim with an actionable status.
 */
function asConflict(fn) {
  try {
    return fn();
  } catch (err) {
    throw new ServerError(err.message, { status: 409, code: 'ANIMATION_TRACK_CONFLICT' });
  }
}

/**
 * The user-facing subset of a row, in the shape the CRUD surface accepts.
 *
 * Whitelisted from `AUTHORED_TRACK_FIELDS` rather than spread-minus-derived, so a
 * round-trip through the editor can't carry an unknown key from a hand-edited store
 * back into a saved row and have it silently persist — and so this list and the
 * request schema's cannot drift (see that constant's header).
 */
const authoredFields = (row) => ({
  id: row.id,
  ...Object.fromEntries(AUTHORED_TRACK_FIELDS.map((key) => (
    [key, Array.isArray(row[key]) ? [...row[key]] : row[key]]
  ))),
});

/**
 * Whether a row is its record kinds' publishable baseline: true only when NONE of
 * the kinds it claims is already owned by another row in the SAME prospective table.
 *
 * `rows` is the whole post-mutation row set (not the pre-image), which is what makes
 * a promotion work: deleting `place`'s baseline must let a surviving `place` track
 * become one, and deriving against the table as it WAS would instead leave that kind
 * with zero owners and 409 on a delete that should have succeeded.
 *
 * Order-dependent by design: within one table the earlier row wins a contested kind,
 * matching the registry's `walk`-first registration order, so the answer is stable
 * across installs rather than dependent on which row happened to be recomposed
 * first.
 */
function withDerivedBaselines(rows, builtins) {
  // Seed from the BUILTINS only: their claim is compiled in and fixed, while every
  // stored row's answer is what this function decides below (a row arrives from
  // `composeRow` with no `standaloneContract` at all).
  const claimed = new Set();
  for (const row of builtins) {
    if (row.standaloneContract) for (const kind of row.kinds) claimed.add(kind);
  }
  return rows.map((row) => {
    const standaloneContract = row.kinds.every((kind) => !claimed.has(kind));
    if (standaloneContract) for (const kind of row.kinds) claimed.add(kind);
    return { ...row, standaloneContract };
  });
}

/**
 * A stored row's PortOS-owned fields, minus `standaloneContract` (a cross-row answer
 * `withDerivedBaselines` fills in once the whole table is known).
 *
 * `existing` is the row already on disk, and its presence is load-bearing: when
 * there is one, the five discriminators are carried over VERBATIM rather than
 * re-derived. A row whose `setKind` was hand-edited (or seeded under different
 * wording — the shipped `scanner` row's `reviewed-directional-scanner-selection` is
 * not what `deriveTrackFields('scanner')` produces) names files an approved set on
 * this machine already carries, so re-deriving during an unrelated label edit would
 * rename the artifact the atlas compiler re-verifies and silently orphan that set.
 * Only a brand-new id derives them.
 */
const composeRow = (authored, existing = null) => ({
  ...authored,
  ...(existing ? {
    contractFrameCountField: existing.contractFrameCountField,
    contractFpsField: existing.contractFpsField,
    selectionKind: existing.selectionKind,
    setKind: existing.setKind,
    finalErrorCode: existing.finalErrorCode,
  } : deriveTrackFields(authored.id)),
  builtin: false,
});

/**
 * The prospective stored-row set for a mutation, with every row's discriminators
 * preserved and every `standaloneContract` re-derived over the RESULT.
 *
 * `added` is a brand-new authored row, `replacement` swaps in for its own id, and
 * `dropId` removes one — the three mutations expressed as one table rebuild, so
 * baseline promotion/demotion is computed the same way whichever one ran.
 */
const nextStoredRows = (tracks, { added = null, replacement = null, dropId = null } = {}) => {
  const kept = storedRows(tracks)
    .filter((row) => row.id !== dropId)
    .map((row) => composeRow(
      replacement && row.id === replacement.id ? replacement : authoredFields(row),
      row,
    ));
  const rows = added ? [...kept, composeRow(added)] : kept;
  return withDerivedBaselines(rows, builtinRows(tracks));
};

/**
 * The effective table — every read on this surface goes through this rather than the
 * store's getter, so a hand-broken store can't reach one path as a 409 and another
 * as a 500.
 */
const effectiveTracksOrThrow = () => asConflict(getEffectiveAnimationTracks);

/**
 * Every track the effective registry knows, built-in first.
 *
 * Returns the FULL rows (derived fields included), because the drawer shows the
 * user which on-disk kinds and contract field their id produced — that is how a
 * collision refusal below becomes actionable rather than mysterious.
 */
export function listAnimationTracks() {
  return {
    tracks: Object.values(effectiveTracksOrThrow()),
    storePath: ANIMATION_TRACK_STORE_REL,
  };
}

/**
 * Persist a stored-row set, then drop the registry cache.
 *
 * The seed's `_comment` is deliberately NOT carried over: once the user has saved
 * through the UI this file is theirs, and a note explaining which rows shipped as
 * seed data stops being true the moment they edit one.
 */
async function writeStoredRows(rows) {
  await atomicWrite(animationTrackStorePath(), {
    schemaVersion: ANIMATION_TRACK_STORE_SCHEMA_VERSION,
    tracks: rows,
  });
  __resetAnimationTrackStore();
}

/**
 * Validate the prospective merged table (compiled `walk` plus these stored rows)
 * through the SAME guard the store runs at load — so a row saved here can never be
 * one that bricks the next boot. That is the difference between "refused at save time
 * with a message naming the conflict" and a server that won't start.
 */
function assertTableValid(tracks, rows) {
  const byId = [...builtinRows(tracks), ...rows].map((row) => [row.id, row]);
  asConflict(() => assertAnimationTrackRows(Object.fromEntries(byId)));
}

/**
 * Refuse a mutation to a built-in track by name.
 *
 * `walk` is the one mandatory baseline: its bounds feed the Zod schemas and its
 * `setKind` gates every character compile, so editing or deleting it through a data
 * edit would brick authoring with no code change to point at. The store's loader
 * already refuses a row that shadows it; this is the same refusal at the surface
 * where the user would otherwise get a 404 for a track they can plainly see.
 */
function refuseBuiltin(trackId, tracks) {
  const row = tracks[trackId];
  if (trackId === WALK_TRACK || (row && row.builtin)) {
    throw new ServerError(
      `'${trackId}' is a built-in animation type and cannot be edited or deleted`,
      { status: 409, code: 'BUILTIN_ANIMATION_TRACK' },
    );
  }
}

/** 409 for a built-in, 404 for a well-formed id that names no stored track. */
function requireStored(trackId, tracks) {
  refuseBuiltin(trackId, tracks);
  const row = tracks[trackId];
  if (!row) {
    throw new ServerError(
      `Unknown animation type '${trackId}' — the registered types are: ${Object.keys(tracks).join(', ')}`,
      { status: 404, code: 'UNKNOWN_ANIMATION_TRACK' },
    );
  }
  return row;
}

/**
 * Refuse a mutation that would orphan authored work, listing the records.
 *
 * "In use" is any record carrying this track's finalized set OR a review selection
 * with at least one approved direction — both are renders the user approved, both
 * are keyed by the `setKind`/`selectionKind` strings a delete removes from the
 * registry, and after either mutation the atlas compiler would find on-disk
 * evidence for a track it no longer knows (or, on a directionality flip, would
 * expect a different number of rows than the set was frozen with).
 *
 * No force flag, deliberately (#3153): a force-delete that silently drops approved
 * renders is worse than a refusal the user can act on by reopening those sets
 * first. The message names the records so that action is obvious.
 */
async function refuseIfInUse(trackId, action) {
  const recordIds = await recordsCarryingTrack(trackId);
  if (!recordIds.length) return;
  throw new ServerError(
    `Cannot ${action} '${trackId}' — ${recordIds.length} sprite${recordIds.length === 1 ? '' : 's'} `
    + `already ${recordIds.length === 1 ? 'carries' : 'carry'} approved ${trackId} work: ${recordIds.join(', ')}. `
    + 'Reopen or unlock those sets first.',
    { status: 409, code: 'ANIMATION_TRACK_IN_USE', context: { records: recordIds } },
  );
}

// Every mutation answers with the fresh table plus the honest scope boundary, so
// the client never has to guess whether its write is live.
const mutationResult = () => ({ ...listAnimationTracks(), restartRequired: true });

/** Create one user-defined animation type. */
export function createAnimationTrack(input) {
  return queueStoreWrite(async () => {
    const tracks = effectiveTracksOrThrow();
    if (tracks[input.id]) {
      refuseBuiltin(input.id, tracks);
      throw new ServerError(
        `Animation type '${input.id}' already exists — edit it instead, or choose another id`,
        { status: 409, code: 'ANIMATION_TRACK_EXISTS' },
      );
    }
    const rows = nextStoredRows(tracks, { added: input });
    assertTableValid(tracks, rows);
    await writeStoredRows(rows);
    return mutationResult();
  });
}

/**
 * Update one user-defined animation type. `id` is immutable — renaming would have
 * to migrate the on-disk `<trackId>/` directories, every run's `track` field and
 * every manifest, so it is a delete-plus-create the user makes explicitly.
 *
 * A directionality FLIP on an in-use track is refused like a delete: the finalized
 * set was frozen with a `directionOrder` derived from the old value and the
 * compiler validates row counts against the new one, so the two would disagree
 * about what is on disk. Every other field (label, bounds, prompt) is safe to
 * retune with work already authored — the packer clamps into the new range.
 */
export function updateAnimationTrack(trackId, patch) {
  return queueStoreWrite(async () => {
    const tracks = effectiveTracksOrThrow();
    const existing = authoredFields(requireStored(trackId, tracks));
    const next = { ...existing, ...patch, id: trackId };
    if (next.directional !== existing.directional) {
      await refuseIfInUse(trackId, 'change the facing mode of');
    }
    const rows = nextStoredRows(tracks, { replacement: next });
    assertTableValid(tracks, rows);
    await writeStoredRows(rows);
    return mutationResult();
  });
}

/** Delete one user-defined animation type, refusing when work depends on it. */
export function deleteAnimationTrack(trackId) {
  return queueStoreWrite(async () => {
    const tracks = effectiveTracksOrThrow();
    requireStored(trackId, tracks);
    await refuseIfInUse(trackId, 'delete');
    const rows = nextStoredRows(tracks, { dropId: trackId });
    assertTableValid(tracks, rows);
    await writeStoredRows(rows);
    return mutationResult();
  });
}

/**
 * Whether this install has its own store file yet, and where the rows came from.
 *
 * Surfaced so the drawer can say "these are the shipped starter types" before the
 * first save — a user who deletes one needs to know the file is about to become
 * theirs and stop tracking the seed.
 */
export async function animationTrackStoreOrigin() {
  return (await pathExists(animationTrackStorePath())) ? 'store' : 'seed';
}

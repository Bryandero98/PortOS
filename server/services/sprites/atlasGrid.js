/**
 * Sprites — the atlas grid: column spans, per-track uniformity, and the
 * up-to-date comparison (issue #3016).
 *
 * The runtime atlas used to be walk-shaped by construction: `atlasColumns()`
 * was literally `['idle', ...walkLabels]`, and the compiler refused any set
 * whose directions disagreed on frame count. Both were right for a world with
 * exactly one animation and both blocked a second — a four-frame scanner action
 * beside a twelve-frame walk needs the grid to express **variable-length column
 * spans**, and needs uniformity to be a *within-track* rule (all 8 facings of
 * one track share a row width) rather than a *between-track* one.
 *
 * This module is that grid. It owns three things the write side (atlas.js) and
 * the describe side (atlasLayout.js) must never disagree about:
 *
 * - **`buildAtlasGrid`** — the span builder. `idle` is column 0, then each
 *   track's columns in stable registry-registration order, yielding both the
 *   flat `columns` list and the `{ start, count }` `tracks` descriptor the
 *   published `layout.json` sidecar carries (#2982).
 * - **`resolveTrackUniformity`** — one track's frame count / fps resolved from
 *   its per-direction rows, asserting the 8 facings agree. It NEVER compares one
 *   track to another, and it range-checks against the *named track's* registry
 *   row (#3015) rather than the global walk-shaped constants.
 * - **`deriveTracks` / `compiledGridUpToDate`** — reading a persisted grid back,
 *   including every legacy shape (a pointer with no `tracks` field, a pre-#2986
 *   grid that still carries a `scanner` column, a pre-#2970 one with no
 *   `walkFrameCount`).
 *
 * **Sharp-free leaf, deliberately** — same contract as `animationTracks.js` and
 * `walkBounds.js`. atlas.js imports sharp; atlasLayout.js must not, so the one
 * definition of a column span has to live below both. Nothing here touches fs,
 * state, or the image graph.
 *
 * **Only ONE track is registered today** (`walk`). The multi-track paths below
 * are proven in `atlasGrid.test.js` against a synthetic REGISTRY TABLE rather
 * than by shipping a second track's artwork. The registry table is the
 * injection seam throughout — the same idiom `assertAnimationTrackRows(tracks)`
 * uses — so a synthetic row flows through exactly the lookup, ordering and
 * unknown-id boundary a real one would. Shipping a real second track is #3018's
 * job, and it should land as a registry ROW plus its pipeline, with no shape
 * change here.
 */

import { ANIMATION_TRACKS, WALK_TRACK, getAnimationTrack } from './animationTracks.js';
import { ATLAS_IDLE_COLUMN, ATLAS_SCANNER_COLUMN, walkPhaseLabels } from './walkBounds.js';
import { canonicalStringify } from '../../lib/objects.js';

/**
 * Column labels for one track's span.
 *
 * The walk track keeps its historical labels verbatim — the named 2-beat gait
 * phases at 8 frames, positional `frame-NN` at any other length — so every
 * existing atlas, manifest, and imported grid round-trips byte-identically.
 *
 * Every OTHER track namespaces its columns with its own id (`scanner-00`).
 * Positional labels are per-track ordinals, so two four-frame tracks would
 * otherwise both emit `frame-00…frame-03` and the flat `columns` list — which
 * consumers are told to resolve BY NAME (docs/features/sprite-export-contract.md)
 * — would carry duplicates that no reader could disambiguate. Namespacing also
 * keeps the legacy `deriveTracks` fallback honest: a duplicated label is exactly
 * what its non-contiguity guard reports as an undescribable grid.
 */
export function trackColumnLabels(trackId, frameCount) {
  // A structural bound, not an authoring one: a track occupies at least one
  // column. Whether the count is *legal to author* is the registry's business
  // and is checked by resolveTrackUniformity against the track's own row.
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new Error(`Atlas track '${trackId}' needs a positive integer frame count, got ${frameCount}`);
  }
  if (trackId === WALK_TRACK) return walkPhaseLabels(frameCount);
  return Array.from({ length: frameCount }, (_, i) => `${trackId}-${String(i).padStart(2, '0')}`);
}

/**
 * Build the atlas grid from a set of track specs (`{ id, frameCount }`).
 *
 * Returns `{ columns, tracks }` where `tracks` maps each track id to its
 * contiguous `{ start, count }` column span — mutually consistent by
 * construction, so the emitted PNG width (`cellSize × columns.length`) and the
 * sidecar's spans can never drift apart.
 *
 * `idle` is always column 0 and is described as a track of its own, matching
 * what the sidecar has always emitted. Specs are sorted into the registry's
 * registration order rather than trusted in call order, so two call sites that
 * list tracks differently still produce the same grid, and an id the registry
 * doesn't know is refused through `getAnimationTrack`'s own unknown-track
 * boundary. The registry TABLE is the injection seam (the
 * `assertAnimationTrackRows(tracks)` idiom) so the multi-track path can be
 * proven against a synthetic table without a private lookup that would bypass
 * that boundary.
 */
export function buildAtlasGrid(specs, tracks = ANIMATION_TRACKS) {
  if (!Array.isArray(specs) || !specs.length) {
    throw new Error('Atlas grid needs at least one animation track');
  }
  const order = Object.keys(tracks);
  const seen = new Set();
  for (const spec of specs) {
    const id = spec?.id;
    if (typeof id !== 'string' || !id) throw new Error('Atlas grid track spec needs an id');
    if (id === ATLAS_IDLE_COLUMN) {
      throw new Error(`Atlas grid cannot register a track named '${ATLAS_IDLE_COLUMN}' — the idle anchor owns that column`);
    }
    if (seen.has(id)) throw new Error(`Atlas grid lists track '${id}' twice`);
    seen.add(id);
    getAnimationTrack(id, tracks);
  }

  const ordered = [...specs].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const columns = [ATLAS_IDLE_COLUMN];
  const spans = { [ATLAS_IDLE_COLUMN]: { start: 0, count: 1 } };
  for (const spec of ordered) {
    // Labels are DERIVED, never supplied: trackColumnLabels is total and
    // deterministic, so accepting them from the caller would only create a
    // mismatch the builder then has to reconcile against itself.
    const labels = trackColumnLabels(spec.id, spec.frameCount);
    spans[spec.id] = { start: columns.length, count: labels.length };
    columns.push(...labels);
  }
  return { columns, tracks: spans };
}

/**
 * The walk-phase columns of a compiled grid: everything that is neither the
 * idle anchor nor a legacy scanner placeholder. Derived from the ACTUAL column
 * names rather than from `walkPhaseLabels(count)`, so a grid whose columns are
 * positional (`frame-00…`) groups into one walk span just like the named
 * 8-frame gait phases. The compiler no longer emits a scanner column (#2986),
 * but imported/pre-#2986 grids still carry one, so it stays filtered here —
 * otherwise their walk-frame count would come back one too high.
 */
const walkColumnsOf = (columns) =>
  columns.filter((c) => c !== ATLAS_IDLE_COLUMN && c !== ATLAS_SCANNER_COLUMN);

/**
 * Walk frame count for a compiled atlas. Pointers written before #2970 have no
 * `walkFrameCount`, so fall back to counting the walk columns themselves.
 */
export function resolveWalkFrameCount(geometry) {
  if (Number.isInteger(geometry?.walkFrameCount)) return geometry.walkFrameCount;
  if (!Array.isArray(geometry?.columns)) return null;
  return walkColumnsOf(geometry.columns).length;
}

/**
 * Validate a persisted `tracks` descriptor against the column list it claims to
 * describe. Returns `{ tracks }` or `{ error }` — never throws, so the
 * idempotency predicate can treat an undescribable grid as "not provably up to
 * date" while `deriveTracks` turns the same reason into a loud failure.
 *
 * A descriptor that is *present* must tile the column list exactly: contiguous,
 * non-overlapping, covering every column. A sidecar whose spans disagree with
 * its own `columns` would silently point a consumer at the wrong pixels, which
 * is the entire failure mode #2982 exists to prevent.
 */
function validateCompiledTracks(compiled, columns) {
  const entries = Object.entries(compiled);
  if (!entries.length) {
    return { error: `Atlas track descriptor is empty but the grid has ${columns.length} columns` };
  }
  for (const [id, span] of entries) {
    if (!Number.isInteger(span?.start) || !Number.isInteger(span?.count)) {
      return { error: `Atlas track "${id}" needs integer start/count` };
    }
    if (span.count < 1) return { error: `Atlas track "${id}" spans ${span.count} columns` };
    if (span.start < 0 || span.start + span.count > columns.length) {
      return { error: `Atlas track "${id}" spans columns ${span.start}–${span.start + span.count - 1}, outside the ${columns.length}-column grid` };
    }
  }
  const sorted = [...entries].sort((a, b) => a[1].start - b[1].start);
  let cursor = 0;
  const tracks = {};
  for (const [id, span] of sorted) {
    if (span.start !== cursor) {
      return { error: `Atlas track "${id}" starts at column ${span.start} but the previous track ends at ${cursor} — the grid is not tiled by its tracks` };
    }
    cursor += span.count;
    tracks[id] = { start: span.start, count: span.count };
  }
  if (cursor !== columns.length) {
    return { error: `Atlas tracks describe ${cursor} of ${columns.length} columns` };
  }
  return { tracks };
}

/**
 * Group a compiled grid into named tracks of contiguous column spans:
 * `{ idle: { start: 0, count: 1 }, walk: { start: 1, count: 8 } }`.
 *
 * `compiledTracks` — the descriptor the compiler persisted into the manifest
 * geometry — is authoritative when **present**, which is what lets a grid carry
 * two tracks of differing length that no column-name heuristic could recover.
 * When it is **absent** (`undefined`/`null` — every atlas compiled before
 * #3016), fall back to the historical derivation: the `walkFrameCount` columns
 * following the idle anchor are the walk track, and every other column becomes a
 * track of its own named for the column, so a legacy grid's one-column `scanner`
 * placeholder is still described honestly rather than folded into the walk span.
 *
 * Absent and present-but-empty are deliberately NOT the same: `{}` is a present
 * descriptor that fails to describe the grid, and it is rejected rather than
 * silently re-derived.
 */
export function deriveTracks(columns, walkFrameCount, compiledTracks = null) {
  const described = describeTracks(columns, walkFrameCount, compiledTracks);
  if (described.error) throw new Error(described.error);
  return described.tracks;
}

/** Non-throwing `deriveTracks` — `{ tracks }` or `{ error }`. */
function describeTracks(columns, walkFrameCount, compiledTracks = null) {
  if (!Array.isArray(columns) || !columns.length) {
    return { error: 'Compiled atlas geometry has no column list' };
  }
  if (compiledTracks !== null && compiledTracks !== undefined) {
    if (typeof compiledTracks !== 'object' || Array.isArray(compiledTracks)) {
      return { error: 'Atlas track descriptor must be an object of column spans' };
    }
    return validateCompiledTracks(compiledTracks, columns);
  }

  const walkStart = columns[0] === ATLAS_IDLE_COLUMN ? 1 : 0;
  const walkEnd = walkStart + (Number.isInteger(walkFrameCount) ? walkFrameCount : 0);
  const tracks = {};
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index];
    const name = index >= walkStart && index < walkEnd ? WALK_TRACK : column;
    const existing = tracks[name];
    if (!existing) {
      tracks[name] = { start: index, count: 1 };
      continue;
    }
    if (existing.start + existing.count !== index) {
      // A track split across non-adjacent columns can't be described as a
      // span — refuse rather than emit a layout that lies about the grid.
      return { error: `Atlas column "${column}" repeats non-contiguously — the grid cannot be described as tracks` };
    }
    existing.count += 1;
  }
  return { tracks };
}

/**
 * True when a persisted pointer geometry describes exactly the grid this
 * compile would emit — the pre-pixel idempotency test.
 *
 * #2986 found that comparing only the cell metrics let a grid-SHAPE change look
 * up to date (dropping the trailing scanner column leaves every cell metric
 * identical), so the column list joined the comparison. The **track set** joins
 * it here for the same reason one level up: two different track sets can yield
 * the same number of columns, and — for anything that labels its frames
 * positionally — could in principle yield the same column *names* too. A grid
 * that re-partitions the same columns into different tracks is a different grid
 * and must recompile.
 *
 * The persisted side is read through `describeTracks`, not compared raw, so a
 * pointer predating the `tracks` field (every atlas compiled before #3016) is
 * described the legacy way and stays idempotent instead of re-running the whole
 * pixel pipeline on every compile forever. A persisted grid that cannot be
 * described at all is "not provably up to date" — recompile rather than trust it.
 */
export function compiledGridUpToDate(current, expected) {
  if (!current || !expected) return false;
  if (current.cellSize !== expected.cellSize) return false;
  if (JSON.stringify(current.pivot) !== JSON.stringify(expected.pivot)) return false;
  if (current.targetMaxHeight !== expected.targetMaxHeight) return false;
  if (current.targetMaxWidth !== expected.targetMaxWidth) return false;
  if (JSON.stringify(current.columns) !== JSON.stringify(expected.columns)) return false;
  const described = describeTracks(current.columns, resolveWalkFrameCount(current), current.tracks ?? null);
  if (described.error) return false;
  // canonicalStringify, NOT JSON.stringify: the two sides are built by three
  // different producers with three different key-insertion orders
  // (buildAtlasGrid inserts idle then registry order; validateCompiledTracks
  // re-inserts sorted by start; the legacy branch inserts in column-index
  // order). A key-order-sensitive compare would report "not up to date" forever
  // and re-run the whole pixel pipeline on every compile — precisely the
  // failure this predicate exists to avoid.
  return canonicalStringify(described.tracks) === canonicalStringify(expected.tracks);
}

/**
 * Resolve one track's frame count and playback fps from its per-direction rows,
 * asserting that every facing agrees.
 *
 * **Uniformity is a within-track rule.** The atlas is a rectangular grid, so all
 * 8 rows of a given track must share its column span — but two DIFFERENT tracks
 * may legally differ in both length and speed, which is exactly what #3016 makes
 * expressible. Nothing here reaches for another track's numbers, and the range
 * check reads the named track's own registry row (#3015) instead of the global
 * walk-shaped 6–16 / 4–24 constants.
 *
 * `rows` are `{ direction, frameCount, declaredFrameCount, fps }`. The registry
 * `tracks` table is the injection seam (as in `buildAtlasGrid`), and `error` is
 * injectable so this leaf stays free of the error-handler import — callers pass
 * the 422-shaped `compileError`. `defaultFps` covers a track whose historical
 * manifests predate the fps field and must keep resolving to the exact value
 * they always did. Returns `{ id, frameCount, fps, labels }`.
 */
export function resolveTrackUniformity(trackId, rows, {
  tracks = ANIMATION_TRACKS,
  trackRow = getAnimationTrack(trackId, tracks),
  error = (message) => new Error(message),
  defaultFps = trackRow.defaultFps,
} = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    throw error(`Track ${trackId} has no directions to compile`);
  }
  let frameCount = null;
  let fps = null;
  for (const row of rows) {
    const { direction } = row;
    if (frameCount === null) {
      frameCount = row.frameCount;
      if (!Number.isInteger(frameCount)
        || frameCount < trackRow.minFrameCount || frameCount > trackRow.maxFrameCount) {
        throw error(`Direction ${direction} has ${row.frameCount} frames — outside the supported ${trackRow.minFrameCount}–${trackRow.maxFrameCount} range`);
      }
    } else if (row.frameCount !== frameCount) {
      throw error(`Direction ${direction} has ${row.frameCount} frames but the set uses ${frameCount} — reprocess all directions to the same frame count before compiling`);
    }
    if (Number.isInteger(row.declaredFrameCount) && row.declaredFrameCount !== row.frameCount) {
      throw error(`Direction ${direction} manifest declares ${row.declaredFrameCount} frames but carries ${row.frameCount}`);
    }
    // Playback fps likewise must agree across a track's directions so the whole
    // track animates at one speed. Range-checked; a manifest with no frameRate
    // falls back to the legacy default so older sets still compile.
    const rowFps = Number.isFinite(row.fps) ? row.fps : defaultFps;
    if (rowFps < trackRow.minFps || rowFps > trackRow.maxFps) {
      throw error(`Direction ${direction} playback fps ${rowFps} is outside the supported ${trackRow.minFps}–${trackRow.maxFps} range`);
    }
    if (fps === null) {
      fps = rowFps;
    } else if (rowFps !== fps) {
      throw error(`Direction ${direction} plays at ${rowFps} fps but the set uses ${fps} — reprocess all directions to the same speed before compiling`);
    }
  }
  return { id: trackId, frameCount, fps, labels: trackColumnLabels(trackId, frameCount) };
}

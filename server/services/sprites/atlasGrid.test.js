/**
 * The atlas grid (#3016) — column spans, per-track uniformity, and the
 * pre-pixel up-to-date comparison. Pure module: no fs, no compiler, no sharp.
 *
 * Only ONE track (`walk`) is registered today, so every multi-track assertion
 * here runs against a SYNTHETIC registry table — the same injected-table idiom
 * `assertAnimationTrackRows(tracks)` uses, so a synthetic row flows through
 * exactly the lookup, ordering and unknown-id boundary a real second row would.
 *
 * That is deliberate: proving the multi-track path against the shipped
 * single-row table would only re-derive the implementation — the whole span
 * builder could collapse back to `['idle', ...walkLabels]` and such a test would
 * stay green, which is exactly the regression it exists to prevent. Shipping a
 * real second track is #3018's job.
 */

import { describe, it, expect } from 'vitest';
import {
  trackColumnLabels, buildAtlasGrid, deriveTracks,
  resolveWalkFrameCount, compiledGridUpToDate, resolveTrackUniformity,
} from './atlasGrid.js';
import { walkPhaseLabels } from './walkBounds.js';
import { getAnimationTrack, ANIMATION_TRACKS } from './animationTracks.js';

// A second track that does NOT exist in the registry, shaped like a short
// action animation: four frames, which sits BELOW walk's floor of 6 — the exact
// case #3015's per-track bounds and #3016's per-track uniformity exist for.
const SCANNER_ROW = Object.freeze({
  id: 'scanner',
  label: 'Scanner sweep',
  directional: true,
  minFrameCount: 2,
  maxFrameCount: 8,
  defaultFrameCount: 4,
  minFps: 2,
  maxFps: 12,
  defaultFps: 6,
  contractFrameCountField: 'scannerFrameCount',
  contractFpsField: null,
});
const TWO_TRACK_REGISTRY = Object.freeze({ walk: ANIMATION_TRACKS.walk, scanner: SCANNER_ROW });
const DIRECTIONS = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'];

const rowsFor = (frameCount, fps, overrides = {}) =>
  DIRECTIONS.map((direction) => ({
    direction, frameCount, declaredFrameCount: frameCount, fps, ...overrides,
  }));

describe('trackColumnLabels', () => {
  it('keeps the walk track on its historical labels', () => {
    // Named 2-beat gait phases at 8 frames, positional otherwise — so existing
    // and imported atlases round-trip byte-identically.
    expect(trackColumnLabels('walk', 8)).toEqual(walkPhaseLabels(8));
    expect(trackColumnLabels('walk', 12)).toEqual(walkPhaseLabels(12));
    expect(trackColumnLabels('walk', 12)[0]).toBe('frame-00');
  });

  it('namespaces every other track so two tracks cannot collide on a column name', () => {
    expect(trackColumnLabels('scanner', 4)).toEqual(['scanner-00', 'scanner-01', 'scanner-02', 'scanner-03']);
    // The failure this prevents: positional labels are per-track ordinals, so
    // two 4-frame tracks would otherwise both emit `frame-00…frame-03` and the
    // flat column list — which consumers resolve BY NAME — would carry
    // duplicates no reader could disambiguate.
    const a = trackColumnLabels('scanner', 4);
    const b = trackColumnLabels('idle-loop', 4);
    expect(a.filter((label) => b.includes(label))).toEqual([]);
  });

  it('refuses a non-positive or non-integer frame count', () => {
    expect(() => trackColumnLabels('scanner', 0)).toThrow(/positive integer frame count/);
    expect(() => trackColumnLabels('scanner', 2.5)).toThrow(/positive integer frame count/);
  });
});

describe('buildAtlasGrid', () => {
  it('emits idle first, then one contiguous span per track', () => {
    const grid = buildAtlasGrid([{ id: 'walk', frameCount: 8 }]);
    expect(grid.columns).toEqual(['idle', ...walkPhaseLabels(8)]);
    expect(grid.tracks).toEqual({ idle: { start: 0, count: 1 }, walk: { start: 1, count: 8 } });
  });

  it('packs two tracks of DIFFERENT lengths into one grid', () => {
    // The whole point of #3016: a 4-frame action beside a 12-frame walk.
    const grid = buildAtlasGrid(
      [{ id: 'walk', frameCount: 12 }, { id: 'scanner', frameCount: 4 }],
      TWO_TRACK_REGISTRY,
    );
    expect(grid.columns).toEqual([
      'idle', ...walkPhaseLabels(12),
      'scanner-00', 'scanner-01', 'scanner-02', 'scanner-03',
    ]);
    expect(grid.tracks).toEqual({
      idle: { start: 0, count: 1 },
      walk: { start: 1, count: 12 },
      scanner: { start: 13, count: 4 },
    });
    // columns and tracks stay mutually consistent — the spans tile the grid,
    // so the emitted PNG width (cellSize × columns.length) matches what the
    // sidecar tells a consumer to sample.
    const spanned = Object.values(grid.tracks).reduce((n, s) => n + s.count, 0);
    expect(spanned).toBe(grid.columns.length);
    expect(grid.columns.length).toBe(17);
  });

  it('sorts specs into registration order rather than call order', () => {
    const asGiven = buildAtlasGrid(
      [{ id: 'scanner', frameCount: 4 }, { id: 'walk', frameCount: 6 }],
      TWO_TRACK_REGISTRY,
    );
    const reversed = buildAtlasGrid(
      [{ id: 'walk', frameCount: 6 }, { id: 'scanner', frameCount: 4 }],
      TWO_TRACK_REGISTRY,
    );
    expect(asGiven).toEqual(reversed);
    expect(asGiven.tracks.walk.start).toBeLessThan(asGiven.tracks.scanner.start);
  });

  it('refuses a spec set it cannot describe', () => {
    expect(() => buildAtlasGrid([])).toThrow(/at least one animation track/);
    expect(() => buildAtlasGrid([{ frameCount: 8 }])).toThrow(/needs an id/);
    expect(() => buildAtlasGrid([{ id: 'walk', frameCount: 8 }, { id: 'walk', frameCount: 6 }]))
      .toThrow(/lists track 'walk' twice/);
    // `idle` is the anchor column, never a registrable track — even if some
    // future registry tried to claim it.
    expect(() => buildAtlasGrid([{ id: 'idle', frameCount: 1 }], { idle: SCANNER_ROW }))
      .toThrow(/the idle anchor owns that column/);
    // Unknown ids are refused through the registry's OWN boundary, so the grid
    // can't develop a second, more permissive idea of what a track is.
    expect(() => buildAtlasGrid([{ id: 'scanner', frameCount: 4 }]))
      .toThrow(/Unknown animation track 'scanner'/);
    expect(() => buildAtlasGrid([{ id: 'walk', frameCount: 0 }]))
      .toThrow(/positive integer frame count/);
  });
});

describe('deriveTracks', () => {
  it('prefers a persisted descriptor over the legacy column-name derivation', () => {
    const grid = buildAtlasGrid(
      [{ id: 'walk', frameCount: 6 }, { id: 'scanner', frameCount: 4 }],
      TWO_TRACK_REGISTRY,
    );
    expect(deriveTracks(grid.columns, 6, grid.tracks)).toEqual(grid.tracks);
    // …and the descriptor is genuinely load-bearing: without it the legacy
    // derivation cannot recover a second track's span, it can only hand back
    // four one-column singletons.
    const legacy = deriveTracks(grid.columns, 6, null);
    expect(legacy.scanner).toBeUndefined();
    expect(legacy['scanner-00']).toEqual({ start: 7, count: 1 });
  });

  it('treats an absent descriptor as legacy and a present-but-empty one as invalid', () => {
    // Absent ≠ present-but-empty: `{}` is a descriptor that fails to describe
    // the grid and must be refused, never silently re-derived.
    expect(deriveTracks(['idle', 'a', 'b'], 2, null)).toEqual({
      idle: { start: 0, count: 1 }, walk: { start: 1, count: 2 },
    });
    expect(deriveTracks(['idle', 'a', 'b'], 2, undefined)).toEqual({
      idle: { start: 0, count: 1 }, walk: { start: 1, count: 2 },
    });
    expect(() => deriveTracks(['idle', 'a', 'b'], 2, {})).toThrow(/descriptor is empty/);
  });

  it('refuses a descriptor that does not tile its own column list', () => {
    const columns = ['idle', 'a', 'b', 'c'];
    expect(() => deriveTracks(columns, 3, { idle: { start: 0, count: 1 }, walk: { start: 1, count: 2 } }))
      .toThrow(/describe 3 of 4 columns/);
    // A gap between spans.
    expect(() => deriveTracks(columns, 3, { idle: { start: 0, count: 1 }, walk: { start: 2, count: 2 } }))
      .toThrow(/the grid is not tiled by its tracks/);
    // Overlapping spans.
    expect(() => deriveTracks(columns, 3, { idle: { start: 0, count: 2 }, walk: { start: 1, count: 3 } }))
      .toThrow(/the grid is not tiled by its tracks/);
    // Running off the end.
    expect(() => deriveTracks(columns, 3, { idle: { start: 0, count: 1 }, walk: { start: 1, count: 9 } }))
      .toThrow(/outside the 4-column grid/);
    expect(() => deriveTracks(columns, 3, { idle: { start: 0, count: 1 }, walk: { start: 1, count: 'three' } }))
      .toThrow(/needs integer start\/count/);
    expect(() => deriveTracks(columns, 3, [{ start: 0, count: 4 }]))
      .toThrow(/must be an object of column spans/);
  });

  it('spans the walk by position, so positional frame-NN labels group too', () => {
    // A grid whose columns are `frame-00…` rather than the named gait phases
    // must still describe ONE walk track, not ten singletons.
    expect(deriveTracks(['idle', ...walkPhaseLabels(10)], 10).walk).toEqual({ start: 1, count: 10 });
    // …and a pre-#2986 grid still describes its scanner placeholder honestly
    // rather than folding it into the walk span.
    expect(deriveTracks(['idle', ...walkPhaseLabels(6), 'scanner'], 6)).toEqual({
      idle: { start: 0, count: 1 },
      walk: { start: 1, count: 6 },
      scanner: { start: 7, count: 1 },
    });
    // Any repeated non-walk column groups into its own span too.
    expect(deriveTracks(['idle', 'w0', 'w1', 'scan-a', 'scan-a', 'scan-a'], 2)).toEqual({
      idle: { start: 0, count: 1 },
      walk: { start: 1, count: 2 },
      'scan-a': { start: 3, count: 3 },
    });
  });

  it('reports an undescribable grid rather than lying about it', () => {
    expect(() => deriveTracks(['idle', 'scanner', 'idle'], 0)).toThrow(/non-contiguously/);
    expect(() => deriveTracks([], 0)).toThrow(/no column list/);
  });
});

describe('compiledGridUpToDate', () => {
  const expected = {
    cellSize: 96,
    pivot: [48, 88],
    targetMaxHeight: 74,
    targetMaxWidth: 86,
    ...buildAtlasGrid([{ id: 'walk', frameCount: 8 }]),
  };
  const persisted = (overrides = {}) => ({
    cellSize: 96,
    pivot: [48, 88],
    targetMaxHeight: 74,
    targetMaxWidth: 86,
    columns: [...expected.columns],
    tracks: { ...expected.tracks },
    walkFrameCount: 8,
    ...overrides,
  });

  it('matches an identical grid, and a legacy pointer that predates the tracks field', () => {
    expect(compiledGridUpToDate(persisted(), expected)).toBe(true);
    // Every atlas compiled before #3016 has no `tracks`. It must still read as
    // up to date, or upgrading an install condemns each existing atlas to
    // re-run the whole pixel pipeline on every compile, forever.
    expect(compiledGridUpToDate(persisted({ tracks: undefined }), expected)).toBe(true);
    // Pre-#2970 pointers additionally carry no walkFrameCount; the walk span is
    // recovered by counting the non-anchor columns.
    expect(compiledGridUpToDate(persisted({ tracks: undefined, walkFrameCount: undefined }), expected)).toBe(true);
  });

  it('catches a TRACK-SET change even when the column list is identical', () => {
    // The regression this exists for. #2986 showed a grid-shape change can leave
    // every cell metric identical; one level up, re-partitioning the SAME
    // columns into a different set of tracks leaves even the column count and
    // the column names identical. That is a different grid and must recompile.
    const repartitioned = persisted({
      tracks: {
        idle: { start: 0, count: 1 },
        walk: { start: 1, count: 4 },
        scanner: { start: 5, count: 4 },
      },
    });
    expect(repartitioned.columns).toEqual(expected.columns);
    expect(Object.values(repartitioned.tracks).reduce((n, s) => n + s.count, 0))
      .toBe(Object.values(expected.tracks).reduce((n, s) => n + s.count, 0));
    expect(compiledGridUpToDate(repartitioned, expected)).toBe(false);
  });

  it('catches a column-list change and a cell-metric change', () => {
    // A pre-#2986 grid still carrying the trailing scanner placeholder.
    expect(compiledGridUpToDate(
      persisted({ columns: [...expected.columns, 'scanner'], tracks: undefined }),
      expected,
    )).toBe(false);
    expect(compiledGridUpToDate(persisted({ cellSize: 64 }), expected)).toBe(false);
    expect(compiledGridUpToDate(persisted({ pivot: [48, 90] }), expected)).toBe(false);
    expect(compiledGridUpToDate(persisted({ targetMaxHeight: 70 }), expected)).toBe(false);
    expect(compiledGridUpToDate(persisted({ targetMaxWidth: 80 }), expected)).toBe(false);
  });

  it('treats an undescribable or absent persisted grid as not up to date', () => {
    expect(compiledGridUpToDate(null, expected)).toBe(false);
    expect(compiledGridUpToDate(persisted({ tracks: {} }), expected)).toBe(false);
  });
});

describe('resolveTrackUniformity', () => {
  it('resolves a track from its per-direction rows', () => {
    // Labels are NOT returned — buildAtlasGrid derives them, so the two can't disagree.
    expect(resolveTrackUniformity('walk', rowsFor(12, 10))).toEqual({ id: 'walk', frameCount: 12, fps: 10 });
  });

  it('enforces uniformity WITHIN a track', () => {
    const ragged = rowsFor(12, 10);
    ragged[3] = { ...ragged[3], frameCount: 10, declaredFrameCount: 10 };
    expect(() => resolveTrackUniformity('walk', ragged))
      .toThrow(/Direction NE has 10 frames but the set uses 12/);

    const uneven = rowsFor(12, 10);
    uneven[5] = { ...uneven[5], fps: 16 };
    expect(() => resolveTrackUniformity('walk', uneven))
      .toThrow(/Direction NW plays at 16 fps but the set uses 10/);
  });

  it('lets two DIFFERENT tracks disagree on frame count and speed', () => {
    // The central semantic change of #3016: uniformity is a within-track rule,
    // never a between-track one. A 4-frame / 6 fps scanner sits below walk's
    // floor of 6 frames and is resolved against ITS OWN registry row.
    const walk = resolveTrackUniformity('walk', rowsFor(12, 10));
    const scanner = resolveTrackUniformity('scanner', rowsFor(4, 6), { tracks: TWO_TRACK_REGISTRY });
    expect(walk.frameCount).toBe(12);
    expect(scanner.frameCount).toBe(4);
    expect(scanner.fps).toBe(6);
    // 4 frames would be rejected outright by the walk row it used to share.
    expect(getAnimationTrack('walk').minFrameCount).toBeGreaterThan(scanner.frameCount);
    expect(() => resolveTrackUniformity('walk', rowsFor(4, 6)))
      .toThrow(/outside the supported 6–16 range/);
    // …and 12 frames is out of range for the scanner's own row.
    expect(() => resolveTrackUniformity('scanner', rowsFor(12, 6), { tracks: TWO_TRACK_REGISTRY }))
      .toThrow(/outside the supported 2–8 range/);
    expect(() => resolveTrackUniformity('scanner', rowsFor(4, 20), { tracks: TWO_TRACK_REGISTRY }))
      .toThrow(/fps 20 is outside the supported 2–12 range/);
  });

  it('catches a manifest whose declared count contradicts its frames', () => {
    const rows = rowsFor(12, 10);
    rows[0] = { ...rows[0], declaredFrameCount: 8 };
    expect(() => resolveTrackUniformity('walk', rows))
      .toThrow(/Direction S manifest declares 8 frames but carries 12/);
  });

  it('falls back to the supplied default fps for pre-fps manifests', () => {
    // Older run manifests carry no frameRate at all — they must keep compiling.
    expect(resolveTrackUniformity('walk', rowsFor(12, undefined), { defaultFps: 12 }).fps).toBe(12);
    expect(resolveTrackUniformity('scanner', rowsFor(4, undefined), { tracks: TWO_TRACK_REGISTRY }).fps)
      .toBe(SCANNER_ROW.defaultFps);
  });

  it('routes failures through the caller-supplied error factory', () => {
    // atlas.js passes its 422-shaped compileError; the leaf stays free of the
    // error-handler import.
    const tagged = (message) => Object.assign(new Error(message), { status: 422, code: 'ATLAS_COMPILE_INVALID' });
    expect(() => resolveTrackUniformity('walk', [], { error: tagged }))
      .toThrow(expect.objectContaining({ code: 'ATLAS_COMPILE_INVALID' }));
  });
});

describe('resolveWalkFrameCount', () => {
  it('prefers the declared count, then the descriptor, then the column count', () => {
    expect(resolveWalkFrameCount({ walkFrameCount: 12 })).toBe(12);
    // Pre-#2970 pointers carry no walkFrameCount…
    expect(resolveWalkFrameCount({ columns: ['idle', 'a', 'b'] })).toBe(2);
    // …and a pre-#2986 one is counted without its scanner placeholder.
    expect(resolveWalkFrameCount({ columns: ['idle', 'a', 'b', 'scanner'] })).toBe(2);
    expect(resolveWalkFrameCount({})).toBeNull();
  });

  it('reads a multi-track grid off the descriptor instead of counting columns', () => {
    // "Every non-anchor column is a walk frame" is only true of a one-track
    // grid. Once a second track exists, a character carrying only that track
    // stamps no walkFrameCount, and counting columns would publish a fabricated
    // walk length in the sidecar for an app's runtime contract to be checked
    // against.
    const grid = buildAtlasGrid(
      [{ id: 'walk', frameCount: 12 }, { id: 'scanner', frameCount: 4 }],
      TWO_TRACK_REGISTRY,
    );
    expect(resolveWalkFrameCount({ columns: grid.columns })).toBe(16);
    expect(resolveWalkFrameCount({ columns: grid.columns, tracks: grid.tracks })).toBe(12);
    // A grid with no walk track at all reports nothing rather than inventing one.
    const scannerOnly = buildAtlasGrid([{ id: 'scanner', frameCount: 4 }], TWO_TRACK_REGISTRY);
    expect(resolveWalkFrameCount({ columns: scannerOnly.columns, tracks: scannerOnly.tracks }))
      .toBeNull();
  });
});

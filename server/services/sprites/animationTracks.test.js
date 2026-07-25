/**
 * The per-track animation registry (#3015) — the rows themselves, the
 * unknown-track error boundary, the per-track clamps, and the sharp-free
 * property `server/lib/validation.js` depends on.
 *
 * The walk row is pinned to its historical values on purpose: #3015 is a
 * refactor, and a registry that quietly moved walk's floor would change every
 * render's geometry while looking like plumbing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  WALK_TRACK, ANIMATION_TRACKS, ANIMATION_TRACK_IDS,
  isAnimationTrack, getAnimationTrack, clampTrackFrameCount, clampTrackFps,
} from './animationTracks.js';
import {
  staticImportSpecifiers, staticImportClosure, specifierMatchesPackage,
} from '../../lib/staticImportGraph.js';
import {
  WALK_DEFAULT_FRAME_COUNT as CLIENT_DEFAULT_FRAME_COUNT,
  WALK_DEFAULT_FPS as CLIENT_DEFAULT_FPS,
  WALK_FRAME_COUNT_OPTIONS as CLIENT_FRAME_COUNT_OPTIONS,
  walkFpsOptionsFor as clientWalkFpsOptionsFor,
} from '../../../client/src/lib/spriteTrimmer.js';

const SPRITES_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = dirname(dirname(SPRITES_DIR));

describe('the registry rows', () => {
  it('reproduces the walk track\'s historical bounds and defaults exactly', () => {
    // #3015 is a refactor — walk behaves identically end to end.
    expect(getAnimationTrack(WALK_TRACK)).toMatchObject({
      id: 'walk',
      directional: true,
      minFrameCount: 6,
      maxFrameCount: 16,
      defaultFrameCount: 12,
      minFps: 4,
      maxFps: 24,
      defaultFps: 10,
      contractFrameCountField: 'walkFrameCount',
      contractFpsField: 'walkFps',
    });
  });

  it('describes every declared track completely', () => {
    // Mirrors the module-load guard in animationTracks.js (which is what
    // actually blocks boot on a bad row) so a shape violation reads as a named
    // assertion here rather than only as an import-time throw somewhere else.
    for (const id of ANIMATION_TRACK_IDS) {
      const row = ANIMATION_TRACKS[id];
      expect(row.id, `${id}.id must match its registry key`).toBe(id);
      expect(typeof row.label).toBe('string');
      expect(typeof row.directional).toBe('boolean');
      expect(typeof row.contractFrameCountField).toBe('string');
      // `null` is legal here — a track whose speed an app has no say in — so
      // this must stay as permissive as the module-load guard, or the first row
      // that uses the null form goes red while booting perfectly fine.
      expect(row.contractFpsField === null || typeof row.contractFpsField === 'string').toBe(true);
      for (const field of ['minFrameCount', 'maxFrameCount', 'defaultFrameCount', 'minFps', 'maxFps', 'defaultFps']) {
        expect(Number.isInteger(row[field]), `${id}.${field} must be an integer`).toBe(true);
      }
      expect(row.minFrameCount).toBeLessThanOrEqual(row.maxFrameCount);
      expect(row.minFps).toBeLessThanOrEqual(row.maxFps);
      expect(row.defaultFrameCount).toBeGreaterThanOrEqual(row.minFrameCount);
      expect(row.defaultFrameCount).toBeLessThanOrEqual(row.maxFrameCount);
      expect(row.defaultFps).toBeGreaterThanOrEqual(row.minFps);
      expect(row.defaultFps).toBeLessThanOrEqual(row.maxFps);
    }
  });

  it('never lets two tracks claim the same runtimeContract field', () => {
    // A second row copy-pasted from walk's would make resolveAnimationTarget
    // read the WALK's contract value for that track and report it as locked.
    // The module-load guard rejects it; this pins the property as a named case.
    const claimed = ANIMATION_TRACK_IDS.flatMap((id) => [
      ANIMATION_TRACKS[id].contractFrameCountField,
      ANIMATION_TRACKS[id].contractFpsField,
    ]).filter((f) => f !== null);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('is frozen so a caller cannot mutate the shared bounds', () => {
    expect(() => { ANIMATION_TRACKS.walk.minFrameCount = 1; }).toThrow();
    expect(ANIMATION_TRACKS.walk.minFrameCount).toBe(6);
  });
});

describe('getAnimationTrack — absent vs unrecognized', () => {
  it('treats an absent id as the default track, preserving pre-#3015 call sites', () => {
    expect(getAnimationTrack().id).toBe(WALK_TRACK);
    expect(getAnimationTrack(undefined).id).toBe(WALK_TRACK);
    expect(getAnimationTrack(null).id).toBe(WALK_TRACK);
  });

  it('throws on an unrecognized id instead of falling back to walk\'s range', () => {
    // The sentinel rule: "not set" resolves to the default; "set to something
    // this build does not know" is an error. Silently handing back walk's 6–16
    // would reject a legitimate 4-frame action for reasons nothing explains.
    expect(() => getAnimationTrack('scanner')).toThrow(/Unknown animation track 'scanner'/);
    expect(() => getAnimationTrack('scanner')).toThrow(/known tracks: walk/);
  });

  it('treats an empty string as present-and-invalid, not absent', () => {
    expect(() => getAnimationTrack('')).toThrow(/Unknown animation track/);
  });

  it('rejects a non-string id and inherited Object keys', () => {
    expect(isAnimationTrack('toString')).toBe(false);
    expect(isAnimationTrack(7)).toBe(false);
    expect(() => getAnimationTrack('toString')).toThrow(/Unknown animation track/);
  });
});

describe('per-track clamps', () => {
  it('clamps into the named track\'s range and rounds', () => {
    expect(clampTrackFrameCount(2, WALK_TRACK)).toBe(6);
    expect(clampTrackFrameCount(99, WALK_TRACK)).toBe(16);
    expect(clampTrackFrameCount(11.6, WALK_TRACK)).toBe(12);
    expect(clampTrackFps(1, WALK_TRACK)).toBe(4);
    expect(clampTrackFps(240, WALK_TRACK)).toBe(24);
  });

  it('falls back to the track\'s default for unusable input', () => {
    expect(clampTrackFrameCount('nope', WALK_TRACK)).toBe(12);
    expect(clampTrackFps(undefined, WALK_TRACK)).toBe(10);
  });

  it('defaults to the walk track when none is named', () => {
    expect(clampTrackFrameCount(99)).toBe(16);
    expect(clampTrackFps(99)).toBe(24);
  });

  it('refuses to clamp against an unrecognized track', () => {
    expect(() => clampTrackFrameCount(8, 'scanner')).toThrow(/Unknown animation track/);
    expect(() => clampTrackFps(8, 'scanner')).toThrow(/Unknown animation track/);
  });
});

describe('walkBounds re-reads the walk row (no call-site churn)', () => {
  it('exposes exactly the registry values under its historical export names', async () => {
    const bounds = await import('./walkBounds.js');
    const row = getAnimationTrack(WALK_TRACK);
    expect({
      min: bounds.WALK_MIN_FRAME_COUNT,
      max: bounds.WALK_MAX_FRAME_COUNT,
      def: bounds.WALK_DEFAULT_FRAME_COUNT,
      minFps: bounds.WALK_MIN_FPS,
      maxFps: bounds.WALK_MAX_FPS,
      defFps: bounds.WALK_DEFAULT_FPS,
    }).toEqual({
      min: row.minFrameCount,
      max: row.maxFrameCount,
      def: row.defaultFrameCount,
      minFps: row.minFps,
      maxFps: row.maxFps,
      defFps: row.defaultFps,
    });
  });

  it('keeps clampFrameCount / clampFps behaving as the walk-track clamps', async () => {
    const { clampFrameCount, clampFps } = await import('./walkBounds.js');
    for (const n of [-1, 0, 5, 6, 11.6, 16, 99, 'nope', undefined, null]) {
      expect(clampFrameCount(n)).toBe(clampTrackFrameCount(n, WALK_TRACK));
      expect(clampFps(n)).toBe(clampTrackFps(n, WALK_TRACK));
    }
  });
});

describe('sharp-free leaf property', () => {
  // The property that actually matters is on `server/lib/validation.js`: it
  // builds its sprite frame-count/fps ranges from this registry, and the whole
  // reason walkBounds.js was split out (and now animationTracks.js beneath it)
  // is to keep the native image graph out of REQUEST VALIDATION. Asserting only
  // the three leaves would pass while someone routed sharp into validation.js
  // through any of its ~90 other closure members, so validation.js is the first
  // entry point here, not an afterthought.
  const NATIVE = ['sharp', 'canvas', 'fluent-ffmpeg', '@ffmpeg-installer/ffmpeg'];

  it.each([
    ['the request-validation graph', join(SERVER_DIR, 'lib', 'validation.js')],
    ['animationTracks.js', join(SPRITES_DIR, 'animationTracks.js')],
    ['walkBounds.js', join(SPRITES_DIR, 'walkBounds.js')],
    ['animationTargets.js', join(SPRITES_DIR, 'animationTargets.js')],
  ])('%s reaches no native image/video dependency', (_label, entry) => {
    const { packages } = staticImportClosure(entry);
    const offending = [...packages].filter((p) => NATIVE.some((n) => specifierMatchesPackage(p, n)));
    expect(offending, `must not reach ${offending.join(', ')}`).toEqual([]);
  });

  it('keeps animationTracks.js a true leaf — it imports nothing at all', () => {
    expect(staticImportSpecifiers(join(SPRITES_DIR, 'animationTracks.js'))).toEqual([]);
  });

  it('actually walks the graph (positive control — the guard is not vacuous)', () => {
    // Three ways the assertions above could pass for the wrong reason: the walk
    // never follows relative imports, it never records bare packages, or an
    // unresolvable specifier silently truncates it. Pin the first two against a
    // module that genuinely reaches sharp.
    const walkBounds = staticImportClosure(join(SPRITES_DIR, 'walkBounds.js'));
    expect([...walkBounds.files]).toContain(join(SPRITES_DIR, 'animationTracks.js'));

    const packer = staticImportClosure(join(SPRITES_DIR, 'walkPostprocess.js'));
    expect([...packer.packages], 'walkPostprocess is the native-graph module this split exists to fence off')
      .toContain('sharp');

    // …and that validation.js's closure is genuinely large, so a resolver gap
    // can't make its clean result meaningless.
    expect(staticImportClosure(join(SERVER_DIR, 'lib', 'validation.js')).files.size).toBeGreaterThan(20);
  });
});

describe('client mirror parity', () => {
  // `client/src/lib/spriteTrimmer.js` restates walk's bounds as literals so the
  // pickers can seed their option lists without importing a server module. The
  // registry is now the source of truth for a SET of ranges, so the first real
  // per-track bounds change — the entire motivation for #3015 — would silently
  // desync the picker from the server's Zod range and surface as a 400 with no
  // field-level explanation. Same guard shape as catalogTypes.parity.test.js.
  const walk = getAnimationTrack(WALK_TRACK);

  it('mirrors the walk defaults', () => {
    expect(CLIENT_DEFAULT_FRAME_COUNT).toBe(walk.defaultFrameCount);
    expect(CLIENT_DEFAULT_FPS).toBe(walk.defaultFps);
  });

  it('seeds the frame-count picker from the walk row\'s full range', () => {
    expect(CLIENT_FRAME_COUNT_OPTIONS[0]).toBe(walk.minFrameCount);
    expect(CLIENT_FRAME_COUNT_OPTIONS.at(-1)).toBe(walk.maxFrameCount);
  });

  it('seeds the fps picker within the walk row\'s range', () => {
    // The list is even-stepped, so it need not END exactly on the max — but it
    // must start at the floor, never offer a value the server would reject, AND
    // stay within one step of the ceiling. Without that upper pin the guard
    // passes in precisely the scenario it exists for: raise the row's maxFps and
    // the client's hard-coded 24 still satisfies "≤ max" while the picker
    // silently stops offering speeds the server now accepts.
    const options = clientWalkFpsOptionsFor(walk.defaultFps);
    expect(options[0]).toBe(walk.minFps);
    expect(Math.max(...options)).toBeLessThanOrEqual(walk.maxFps);
    expect(walk.maxFps - Math.max(...options)).toBeLessThan(2);
  });

  it('keeps the publish form\'s hard-coded frame-count bounds in step', () => {
    // PublishWorkflow.jsx is a React component (not importable under the server
    // runner), so its two mirrored literals are asserted as source text.
    const src = readFileSync(
      join(SERVER_DIR, '..', 'client', 'src', 'components', 'sprites', 'PublishWorkflow.jsx'),
      'utf-8',
    );
    expect(src).toContain(`const WALK_MIN_FRAME_COUNT = ${walk.minFrameCount};`);
    expect(src).toContain(`const WALK_MAX_FRAME_COUNT = ${walk.maxFrameCount};`);
  });
});

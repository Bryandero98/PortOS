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
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import {
  WALK_TRACK, ANIMATION_TRACKS, ANIMATION_TRACK_IDS,
  isAnimationTrack, getAnimationTrack, clampTrackFrameCount, clampTrackFps,
} from './animationTracks.js';

const SPRITES_DIR = dirname(fileURLToPath(import.meta.url));

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
    // A row missing a bound would fall through as `undefined` into a Math.min
    // (→ NaN) or a Zod .min() (→ throw at boot); assert the shape up front so
    // adding a track can't half-land.
    for (const id of ANIMATION_TRACK_IDS) {
      const row = ANIMATION_TRACKS[id];
      expect(row.id, `${id}.id must match its registry key`).toBe(id);
      expect(typeof row.label).toBe('string');
      expect(typeof row.directional).toBe('boolean');
      expect(typeof row.contractFrameCountField).toBe('string');
      expect(typeof row.contractFpsField).toBe('string');
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

// Matches `import … from './x.js'` / `export … from './x.js'` / bare
// `import './x.js'` at the start of a line — the same static-only scan
// agentImportCycles.test.js uses. Deliberately does NOT match `await import()`
// (deferred to call time) or the string inside a comment.
const STATIC_FROM = /^\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/gm;
const STATIC_BARE = /^\s*import\s*['"]([^'"]+)['"]/gm;

function staticSpecifiers(file) {
  const src = readFileSync(file, 'utf-8');
  const out = [];
  for (const re of [STATIC_FROM, STATIC_BARE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(src)) !== null) out.push(match[1]);
  }
  return out;
}

/** Every module statically reachable from `entry`, plus the bare packages hit. */
function importClosure(entry) {
  const seen = new Set();
  const packages = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of staticSpecifiers(file)) {
      if (!spec.startsWith('.')) { packages.add(spec); continue; }
      const next = resolve(dirname(file), spec);
      if (existsSync(next)) walk(next);
    }
  };
  walk(entry);
  return { files: seen, packages };
}

describe('sharp-free leaf property', () => {
  // server/lib/validation.js builds its sprite frame-count/fps ranges from this
  // registry. If the registry (or anything it reaches) ever imports sharp, the
  // native image graph lands in the request-validation graph — the exact
  // regression walkBounds.js was split out to prevent, now one level deeper.
  const NATIVE = ['sharp', 'canvas', 'fluent-ffmpeg', '@ffmpeg-installer/ffmpeg'];

  it.each([
    ['animationTracks.js'],
    ['walkBounds.js'],
    ['animationTargets.js'],
  ])('%s reaches no native image/video dependency', (file) => {
    const { packages } = importClosure(join(SPRITES_DIR, file));
    const offending = [...packages].filter((p) => NATIVE.some((n) => p === n || p.startsWith(`${n}/`)));
    expect(offending, `${file} must not reach ${offending.join(', ')}`).toEqual([]);
  });

  it('keeps animationTracks.js a true leaf — it imports nothing at all', () => {
    expect(staticSpecifiers(join(SPRITES_DIR, 'animationTracks.js'))).toEqual([]);
  });

  it('actually walks the graph (positive control — the guard is not vacuous)', () => {
    // Two ways this assertion could pass for the wrong reason: the closure
    // never follows relative imports, or it never records bare packages. Pin
    // both against a module that genuinely reaches sharp.
    const walkBounds = importClosure(join(SPRITES_DIR, 'walkBounds.js'));
    expect([...walkBounds.files]).toContain(join(SPRITES_DIR, 'animationTracks.js'));

    const packer = importClosure(join(SPRITES_DIR, 'walkPostprocess.js'));
    expect([...packer.packages], 'walkPostprocess is the native-graph module this split exists to fence off')
      .toContain('sharp');
  });
});

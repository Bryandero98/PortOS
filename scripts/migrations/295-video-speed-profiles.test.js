import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './295-video-speed-profiles.js';
import { VIDEO_SPEED_PROFILES } from '../../server/lib/videoSpeedProfiles.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const ENTRY_ID = 'ltx25_mlx_q8';
const spec = VIDEO_SPEED_PROFILES[ENTRY_ID];

// The entry as an existing install stores it, pre-migration.
const baseRegistry = (overrides = {}) => ({
  video: {
    macos: [
      {
        id: ENTRY_ID,
        name: 'LTX-2.5 MLX Q8',
        repo: spec.shippedRepo,
        revision: spec.shippedRevision,
        runtime: 'ltx25',
        steps: 8,
        guidance: 3.0,
        ...overrides,
      },
      { id: 'my_custom_model', name: 'My Custom Model', repo: 'example-org/example-video', source: 'user' },
    ],
    windows: [{ id: 'ltx_video', name: 'LTX-Video 0.9.5', runtime: 'cuda_video', steps: 25 }],
    defaultMacos: ENTRY_ID,
  },
});

const findMacos = (path, id) => readJson(path).video.macos.find((e) => e.id === id);

describe('migration 295 — video speed profiles', () => {
  let rootDir;
  let path;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-295-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('attaches the shipped profiles to a pin-matching entry', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const entry = findMacos(path, ENTRY_ID);
    expect(entry.speedProfiles).toHaveLength(spec.profiles.length);
    expect(entry.speedProfiles[0].id).toBe('fast');
    expect(entry.speedProfiles[0].steps).toBe(spec.profiles[0].steps);
  });

  it('leaves everything else on the entry, and its position, untouched', async () => {
    const before = baseRegistry();
    writeJson(path, before);
    await migration.up({ rootDir });
    const after = readJson(path);
    expect(after.video.macos.map((e) => e.id)).toEqual(before.video.macos.map((e) => e.id));
    const { speedProfiles: _added, ...rest } = after.video.macos[0];
    expect(rest).toEqual(before.video.macos[0]);
    expect(after.video.windows).toEqual(before.video.windows);
    expect(after.video.defaultMacos).toBe(ENTRY_ID);
  });

  it('does not touch a custom model', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    expect(findMacos(path, 'my_custom_model').speedProfiles).toBeUndefined();
  });

  it.each([
    ['an existing profiles key', { speedProfiles: [{ id: 'mine', steps: 4, guidance: 1, modes: ['text'] }] }],
    ['an explicit empty-list opt-out', { speedProfiles: [] }],
    ['an explicit null opt-out', { speedProfiles: null }],
  ])('preserves %s rather than overwriting the user', async (_label, overrides) => {
    writeJson(path, baseRegistry(overrides));
    await migration.up({ rootDir });
    expect(findMacos(path, ENTRY_ID).speedProfiles).toEqual(overrides.speedProfiles);
  });

  // The pin guard: a validated sampler schedule must not be claimed for
  // different weights, whichever half of the pin the user changed.
  it.each([
    ['a forked repo', { repo: 'someone/ltx-2.5-fork' }],
    ['a moved revision', { revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }],
  ])('skips an entry with %s', async (_label, overrides) => {
    writeJson(path, baseRegistry(overrides));
    await migration.up({ rootDir });
    expect(findMacos(path, ENTRY_ID).speedProfiles).toBeUndefined();
  });

  it('rewrites nothing (and logs nothing) when there is no entry to profile', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const registry = { video: { macos: [{ id: 'my_custom_model', repo: 'example-org/example-video' }] } };
    writeJson(path, registry);
    const before = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(log).not.toHaveBeenCalled();
  });

  it('is idempotent — a second run is a no-op', async () => {
    writeJson(path, baseRegistry());
    await migration.up({ rootDir });
    const after = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(after);
  });

  it('also covers the legacy bucket spellings', async () => {
    writeJson(path, {
      video: {
        mlx: [{
          id: ENTRY_ID, repo: spec.shippedRepo, revision: spec.shippedRevision, runtime: 'ltx25', steps: 8, guidance: 3.0,
        }],
      },
    });
    await migration.up({ rootDir });
    expect(readJson(path).video.mlx[0].speedProfiles).toHaveLength(spec.profiles.length);
  });

  it('is a no-op when the install has no registry file yet', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });

  it('is a no-op when video is missing or not an object', async () => {
    writeJson(path, { image: [] });
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });

  it('fails loudly on invalid JSON rather than silently rewriting the file', async () => {
    writeFileSync(path, '{ not json');
    await expect(migration.up({ rootDir })).rejects.toThrow(/invalid JSON/);
  });
});

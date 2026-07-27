import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './211-seed-user-defined-animation-tracks.js';

/**
 * Migration 211 — materialize an editable animation-track store (#3152).
 *
 * The behavior that matters is the NON-destructive half: an install where the user
 * has already deleted `scanner`, retuned `ambient`, or broken their JSON must come
 * out the other side untouched. A merge-on-upgrade would resurrect a deleted track
 * every release, which is exactly the "starter entry comes back" trade-off
 * `setup-data.js` documents and which is wrong here — a track's `setKind` gates
 * whether a record compiles, so re-adding one is not cosmetic.
 */

let rootDir;
let seedPath;
let storePath;

// An invented seed (privacy convention) shaped like the shipped one.
const SEED = {
  schemaVersion: 1,
  tracks: [
    { id: 'scanner', label: 'Scanner action', promptTemplate: 'Sweep once.' },
    { id: 'ambient', label: 'Ambient loop', promptTemplate: 'Sway gently.' },
  ],
};

const writeSeed = (obj = SEED) => writeFileSync(
  seedPath, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`,
);
const writeStore = (obj) => {
  mkdirSync(join(rootDir, 'data', 'sprites'), { recursive: true });
  writeFileSync(storePath, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`);
};
const readStore = () => JSON.parse(readFileSync(storePath, 'utf-8'));

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'migration-211-'));
  seedPath = join(rootDir, 'data.reference', 'sprites', 'animation-tracks.json');
  storePath = join(rootDir, 'data', 'sprites', 'animation-tracks.json');
  mkdirSync(join(rootDir, 'data.reference', 'sprites'), { recursive: true });
});

afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

describe('migration 211 — seed the user-defined animation-track store', () => {
  it('creates the store (with parent dirs) from the shipped seed', async () => {
    writeSeed();
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: true, reason: 'seeded', count: 2 });
    expect(readStore().tracks.map((t) => t.id)).toEqual(['scanner', 'ambient']);
  });

  it('copies the seed byte-for-byte, so the shipped prompts arrive intact', async () => {
    // Not re-serialized: a round-trip through JSON.parse/stringify would silently
    // drop the seed's explanatory `_comment` and reformat the prompt strings a
    // user is about to edit.
    writeSeed();
    await migration.up({ rootDir });
    expect(readFileSync(storePath, 'utf-8')).toBe(readFileSync(seedPath, 'utf-8'));
  });

  it('leaves an existing store completely alone (a deleted track STAYS deleted)', async () => {
    // The regression a merge would cause: `scanner` comes back every upgrade.
    const userStore = { schemaVersion: 1, tracks: [{ id: 'ambient', label: 'My ambient' }] };
    writeStore(userStore);
    writeSeed();
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: true, reason: 'already-present' });
    expect(readStore()).toEqual(userStore);
  });

  it('leaves an UNREADABLE existing store alone rather than reseeding over it', async () => {
    // Possibly-recoverable user edits beat a clean reseed.
    const broken = '{ "tracks": [ oops ';
    writeStore(broken);
    writeSeed();
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: true, reason: 'already-present' });
    expect(readFileSync(storePath, 'utf-8')).toBe(broken);
  });

  it('is idempotent — a second run is a no-op', async () => {
    writeSeed();
    await migration.up({ rootDir });
    const after = readFileSync(storePath, 'utf-8');
    const second = await migration.up({ rootDir });
    expect(second).toMatchObject({ reason: 'already-present' });
    expect(readFileSync(storePath, 'utf-8')).toBe(after);
  });

  it('no-ops (without throwing) when the seed file is missing', async () => {
    // A packaging gap, not a data problem — the store's own data.reference
    // fallback already covers the runtime, so this must not fail the whole
    // migration run and block every later migration.
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: true, reason: 'no-seed' });
    expect(existsSync(storePath)).toBe(false);
  });

  it('refuses to write a corrupt seed into data/', async () => {
    // Shipping invalid JSON into `data/` would turn the store's "exists but
    // unreadable" throw into a boot failure over a file the user never created.
    writeSeed('{ nope ');
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: true, reason: 'invalid-seed' });
    expect(existsSync(storePath)).toBe(false);
  });
});

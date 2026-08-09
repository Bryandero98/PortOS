/**
 * Obsidian readers against an EVICTED (iCloud-offloaded) note — #3704.
 *
 * Kept separate from `obsidian.test.js` because that suite deliberately runs
 * against a real temp vault with no mocks; here `../lib/icloudFile.js` is mocked
 * so one specific note behaves as evicted while its neighbours read normally.
 *
 * What this pins: an evicted note must never be *silently* dropped. Before the
 * guard, reading one blocked the process forever; the guard makes the read fail
 * fast, and the risk that replaces the hang is a vault-wide reader reporting
 * "no results" for a query whose answer sits in an un-downloaded note. Each
 * reader therefore reports a `skippedUnavailable` count, and `getNote` reports
 * NOTE_EVICTED rather than NOTE_NOT_FOUND.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-obsidian-evicted-');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

// Only `evicted.md` is treated as offloaded; every other path reads for real, so
// the assertions below distinguish "skipped that one note" from "read nothing".
vi.mock('../lib/icloudFile.js', () => ({
  ICLOUD_NOT_MATERIALIZED: 'ICLOUD_NOT_MATERIALIZED',
  readIfMaterialized: vi.fn(async (path) => {
    if (path.endsWith('evicted.md')) {
      throw Object.assign(new Error('evicted'), { code: 'ICLOUD_NOT_MATERIALIZED' });
    }
    return readFile(path, 'utf-8');
  }),
}));

const { addVault, scanVault, searchNotes, getVaultTags, getVaultGraph, getNote } =
  await import('./obsidian.js');

const VAULT_DIR = join(tempRoot, 'vault');
let vaultId;

beforeEach(async () => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(join(VAULT_DIR, '.obsidian'), { recursive: true });
  // `readable.md` and `evicted.md` both match the search term and share a tag, so
  // every reader below has exactly one skipped note and one real hit.
  writeFileSync(join(VAULT_DIR, 'readable.md'), '---\ntags: [biology]\n---\nmitochondria here\n[[evicted]]\n');
  writeFileSync(join(VAULT_DIR, 'evicted.md'), '---\ntags: [biology, offloaded]\n---\nmitochondria there too\n');
  const vault = await addVault({ name: 'Test Vault', path: VAULT_DIR });
  vaultId = vault.id;
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('obsidian readers with an evicted note', () => {
  it('scanVault skips the evicted note and reports the count', async () => {
    const result = await scanVault(vaultId);
    expect(result.notes.map(n => n.name)).toEqual(['readable']);
    expect(result.skippedUnavailable).toBe(1);
  });

  it('searchNotes reports skipped notes instead of implying no match exists', async () => {
    const result = await searchNotes(vaultId, 'mitochondria');
    // The term is in BOTH notes; only the readable one can be reported.
    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe('readable');
    // Without this the UI renders a bare "No/1 results" and the user concludes
    // the other note doesn't contain the term.
    expect(result.skippedUnavailable).toBe(1);
  });

  it('getVaultTags under-counts visibly, not silently', async () => {
    const result = await getVaultTags(vaultId);
    const biology = result.tags.find(t => t.tag === 'biology');
    expect(biology.count).toBe(1);            // 2 notes carry it; 1 is unreadable
    expect(result.tags.find(t => t.tag === 'offloaded')).toBeUndefined();
    expect(result.skippedUnavailable).toBe(1);
  });

  it('getVaultGraph drops the evicted node and says so', async () => {
    const result = await getVaultGraph(vaultId);
    expect(result.nodes.map(n => n.name)).toEqual(['readable']);
    // The [[evicted]] wikilink can't resolve to a node that was never collected,
    // so the edge silently vanishes too — hence the count.
    expect(result.edges).toHaveLength(0);
    expect(result.skippedUnavailable).toBe(1);
  });

  it('getNote reports NOTE_EVICTED, not NOTE_NOT_FOUND', async () => {
    const result = await getNote(vaultId, 'evicted.md');
    // NOTE_NOT_FOUND would tell the user a note they can see in Obsidian is gone.
    expect(result.error).toBe('NOTE_EVICTED');
    expect(result.message).toMatch(/iCloud/i);
  });

  it('getNote still reads a materialized note normally', async () => {
    const result = await getNote(vaultId, 'readable.md');
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('mitochondria');
  });

  it('a non-eviction read error still propagates (not swallowed as a skip)', async () => {
    const { readIfMaterialized } = await import('../lib/icloudFile.js');
    readIfMaterialized.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EIO' }));
    await expect(getNote(vaultId, 'readable.md')).rejects.toThrow('boom');
  });
});

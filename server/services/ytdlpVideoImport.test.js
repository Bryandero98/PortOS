/**
 * The shared yt-dlp video core's output detection.
 *
 * These cases moved here from videoDownload.test.js when the yt-dlp spawn was
 * extracted for the YouTube brain ingest: the "don't assume .mp4, don't pick up
 * an intermediate" rule is a property of the core both callers use, not of the
 * Dev Tools downloader that used to own it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { findProducedFile, cleanupProducedFiles } from './ytdlpVideoImport.js';

describe('findProducedFile (robust output detection)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'viddl-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('prefers an exact .mp4 over other candidates', async () => {
    await writeFile(join(dir, 'downloaded-x.mp4'), 'v');
    await writeFile(join(dir, 'downloaded-x.webm'), 'v');
    expect(await findProducedFile('downloaded-x', dir)).toBe('downloaded-x.mp4');
  });

  it('finds a non-mp4 single-file result (the .mp4-assumption bug)', async () => {
    await writeFile(join(dir, 'downloaded-y.webm'), 'v');
    expect(await findProducedFile('downloaded-y', dir)).toBe('downloaded-y.webm');
  });

  it('ignores in-progress and format-fragment intermediates', async () => {
    await writeFile(join(dir, 'downloaded-z.f137.mp4'), 'v'); // fragment
    await writeFile(join(dir, 'downloaded-z.mp4.part'), 'v'); // partial
    await writeFile(join(dir, 'downloaded-z.webm.ytdl'), 'v'); // sidecar
    expect(await findProducedFile('downloaded-z', dir)).toBeNull();
  });

  it('does not match a different job id', async () => {
    await writeFile(join(dir, 'downloaded-other.mp4'), 'v');
    expect(await findProducedFile('downloaded-mine', dir)).toBeNull();
  });

  it('returns null for a directory that does not exist', async () => {
    expect(await findProducedFile('downloaded-x', join(dir, 'nope'))).toBeNull();
  });
});

describe('cleanupProducedFiles', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'viddl-clean-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('removes every file the prefix touched, including intermediates, and spares others', async () => {
    for (const name of ['downloaded-a.mp4', 'downloaded-a.f137.mp4', 'downloaded-a.mp4.part', 'downloaded-b.mp4']) {
      await writeFile(join(dir, name), 'v');
    }
    await cleanupProducedFiles('downloaded-a', dir);
    // The whole point of globbing the prefix: a cancelled run leaves fragments
    // whose exact names aren't knowable up front.
    expect(await findProducedFile('downloaded-a', dir)).toBeNull();
    expect(await findProducedFile('downloaded-b', dir)).toBe('downloaded-b.mp4');
  });
});

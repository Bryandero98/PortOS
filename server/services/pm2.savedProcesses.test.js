import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// pm2.js imports the `pm2` package at module load (no daemon connection until a
// call is made). Mocked to keep the import side-effect-free in CI.
vi.mock('pm2', () => ({ default: { connect: vi.fn(), list: vi.fn(), disconnect: vi.fn() } }));

import { getSavedProcessNames } from './pm2.js';

/**
 * `getSavedProcessNames` reads `$PM2_HOME/dump.pm2` — the list a boot-time
 * `pm2 resurrect` replays. The LLMs page shows it as "starts at boot" per
 * PM2-managed local runtime server, so absent-vs-empty has to stay legible: an
 * unreadable dump is "unknown", never "this daemon won't come back".
 */
describe('getSavedProcessNames', () => {
  let home;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'portos-pm2-home-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lists the app names in the saved dump', async () => {
    await writeFile(join(home, 'dump.pm2'), JSON.stringify([
      { name: 'portos-server' },
      { name: 'portos-llama-server' },
      { name: 'portos-mtplx' },
    ]));
    expect(await getSavedProcessNames(home)).toEqual(['portos-server', 'portos-llama-server', 'portos-mtplx']);
  });

  it('reports an EMPTY saved list as [] — read fine, saves nothing', async () => {
    await writeFile(join(home, 'dump.pm2'), '[]');
    expect(await getSavedProcessNames(home)).toEqual([]);
  });

  it('returns null when the dump is absent or unreadable', async () => {
    // Never `pm2 save`d on this machine.
    expect(await getSavedProcessNames(home)).toBeNull();
    // Truncated / not the array PM2 writes.
    await writeFile(join(home, 'dump.pm2'), '{"not":"an array"');
    expect(await getSavedProcessNames(home)).toBeNull();
  });

  it('skips entries with no usable name rather than emitting undefined', async () => {
    await writeFile(join(home, 'dump.pm2'), JSON.stringify([{ name: 'portos-mtplx' }, {}, { name: 42 }]));
    expect(await getSavedProcessNames(home)).toEqual(['portos-mtplx']);
  });
});

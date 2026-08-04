import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { rekeyLedger } from './223-quota-burn-ledger-hour-keys.js';

const HOUR_MS = 60 * 60 * 1000;

describe('rekeyLedger', () => {
  it('rounds an exact-epoch key to its hour bucket, carrying the count', () => {
    // 13:59 — the shape that motivated the change. The old key is the exact
    // reset epoch; the new one is the hour it rounds to.
    const exact = Date.UTC(2026, 7, 4, 13, 59);
    const { ledger, changed } = rekeyLedger({ [`claude:${exact}`]: 5 });
    expect(changed).toBe(true);
    expect(ledger).toEqual({ [`claude:${Math.round(exact / HOUR_MS) * HOUR_MS}`]: 5 });
  });

  it('SUMS two old keys that fall into the same hour bucket', () => {
    // The whole point of the new format: one window read twice, seconds apart,
    // produced two keys. Both dispatches really happened, so the merged bucket
    // must show 3 — taking the max would hand back a burn the user paid for.
    const base = Date.UTC(2026, 7, 4, 14, 0);
    const { ledger } = rekeyLedger({
      [`codex:${base + 1000}`]: 2,
      [`codex:${base - 2000}`]: 1,
    });
    expect(ledger).toEqual({ [`codex:${base}`]: 3 });
  });

  it('drops the release-era __agentDispatches sentinel', () => {
    const epoch = Math.round(Date.UTC(2026, 7, 4, 9, 0) / HOUR_MS) * HOUR_MS;
    const { ledger, changed } = rekeyLedger({
      [`grok:${epoch}`]: 1,
      __agentDispatches: { 'agent-1': `grok:${epoch}` },
    });
    expect(changed).toBe(true);
    expect(ledger).toEqual({ [`grok:${epoch}`]: 1 });
  });

  it('carries an unparseable key verbatim rather than forgiving its spend', () => {
    const { ledger } = rekeyLedger({ 'weird-key-no-epoch': 4 });
    expect(ledger).toEqual({ 'weird-key-no-epoch': 4 });
  });

  it('reports no change when every key is already hour-rounded', () => {
    const epoch = Math.round(Date.UTC(2026, 7, 4, 16, 0) / HOUR_MS) * HOUR_MS;
    const { ledger, changed } = rekeyLedger({ [`agy:${epoch}`]: 2 });
    expect(changed).toBe(false);
    expect(ledger).toEqual({ [`agy:${epoch}`]: 2 });
  });
});

describe('migration 223 up()', () => {
  let rootDir;
  const ledgerPath = () => join(rootDir, 'data', 'cos', 'quota-burn-dispatches.json');
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-223-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it('no-ops when the ledger has never been written', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-ledger' });
  });

  it('no-ops on an unparseable ledger rather than throwing the boot migration run', async () => {
    await writeFile(ledgerPath(), 'not json');
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-ledger' });
  });

  it('carries an exhausted window across the key change so it cannot be re-spent', async () => {
    // The upgrade bug this migration exists to close: an install at 5/5 for a
    // 13:59 window would, without it, read 0 under the new key and burn a whole
    // extra cap inside the same window.
    const exact = Date.UTC(2026, 7, 4, 13, 59);
    await writeFile(ledgerPath(), JSON.stringify({ [`claude:${exact}`]: 5 }));

    await migration.up({ rootDir });

    const after = JSON.parse(await readFile(ledgerPath(), 'utf-8'));
    expect(after[`claude:${Math.round(exact / HOUR_MS) * HOUR_MS}`]).toBe(5);
  });

  it('is idempotent — a second run leaves the file byte-identical', async () => {
    const exact = Date.UTC(2026, 7, 4, 13, 59);
    await writeFile(ledgerPath(), JSON.stringify({ [`claude:${exact}`]: 5 }));

    await migration.up({ rootDir });
    const first = await readFile(ledgerPath(), 'utf-8');
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ reason: 'already-hourly' });
    expect(await readFile(ledgerPath(), 'utf-8')).toBe(first);
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-burn-completions-', extraOverrides: (root) => ({ cos: root }) });
vi.mock('../lib/fileUtils.js', async (importActual) => makeProxy(await importActual()));

const {
  clearQuotaBurnJobCompletion, getQuotaBurnCompletions, recordQuotaBurnJobCompletion,
} = await import('./quotaBurnCompletions.js');

const LEDGER = () => join(tempRoot, 'quota-burn-completions.json');
const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const seed = (entries) => writeFileSync(LEDGER(), JSON.stringify(entries));
const onDisk = () => JSON.parse(readFileSync(LEDGER(), 'utf8'));

beforeEach(() => rmSync(LEDGER(), { force: true }));
afterAll(cleanup);

describe('getQuotaBurnCompletions', () => {
  it('reads an empty ledger as no completions rather than failing', async () => {
    await expect(getQuotaBurnCompletions()).resolves.toEqual({});
  });

  it('drops entries that are not a usable instant', async () => {
    // A hand-edited or half-written file must not put a truthy non-string in
    // front of `jobIsSpent`, which would silently retire a job forever.
    seed({ 'grok:a': '2026-08-01T00:00:00.000Z', 'grok:b': null, 'grok:c': 42, 'grok:d': '' });
    await expect(getQuotaBurnCompletions()).resolves.toEqual({ 'grok:a': '2026-08-01T00:00:00.000Z' });
  });

  it('reads a non-object file as no completions', async () => {
    seed(['grok:a']);
    await expect(getQuotaBurnCompletions()).resolves.toEqual({});
  });
});

describe('recordQuotaBurnJobCompletion', () => {
  it('keys the family into the entry so two plans cannot share a completion', async () => {
    // Job ids are minted from a clock and are only unique WITHIN a family, so a
    // bare job id would let one plan's one-shot step retire another's.
    await recordQuotaBurnJobCompletion('grok', 'job-1', { now: NOW });
    await recordQuotaBurnJobCompletion('claude', 'job-1', { now: NOW });
    expect(Object.keys(onDisk()).sort()).toEqual(['claude:job-1', 'grok:job-1']);
  });

  it('re-stamps an existing entry instead of duplicating it', async () => {
    await recordQuotaBurnJobCompletion('grok', 'job-1', { now: NOW - 86_400_000 });
    await recordQuotaBurnJobCompletion('grok', 'job-1', { now: NOW });
    expect(onDisk()).toEqual({ 'grok:job-1': new Date(NOW).toISOString() });
  });

  it('ignores a call with no family or job rather than writing a junk key', async () => {
    await expect(recordQuotaBurnJobCompletion('grok', null)).resolves.toBeNull();
    await expect(recordQuotaBurnJobCompletion(null, 'job-1')).resolves.toBeNull();
    await expect(getQuotaBurnCompletions()).resolves.toEqual({});
  });

  it('prunes the oldest entries only, keeping far more than a live plan can hold', async () => {
    // The cap exists so the file cannot grow by one dead key per deleted job
    // forever. It must never evict a LIVE key — that would put a spent job back
    // into the rotation behind the user's back — so it is set well above the 100
    // keys a maxed-out plan (4 families x 25 jobs) can produce.
    seed(Object.fromEntries(Array.from({ length: 240 }, (_, index) => [
      `grok:old-${index}`, new Date(NOW - (240 - index) * 60_000).toISOString(),
    ])));
    await recordQuotaBurnJobCompletion('grok', 'fresh', { now: NOW });
    const kept = onDisk();
    expect(Object.keys(kept)).toHaveLength(200);
    expect(kept['grok:fresh']).toBe(new Date(NOW).toISOString());
    // Oldest first out: `old-0` is the furthest back, `old-239` the most recent.
    expect(kept['grok:old-0']).toBeUndefined();
    expect(kept['grok:old-239']).toBeDefined();
  });
});

describe('clearQuotaBurnJobCompletion', () => {
  beforeEach(() => seed({
    'grok:a': '2026-08-01T00:00:00.000Z',
    'grok:b': '2026-08-02T00:00:00.000Z',
    'claude:a': '2026-08-03T00:00:00.000Z',
  }));

  it('re-arms one named step', async () => {
    await clearQuotaBurnJobCompletion('grok', 'a');
    expect(Object.keys(onDisk()).sort()).toEqual(['claude:a', 'grok:b']);
  });

  it('re-arms the whole family when no step is named', async () => {
    // "Run that series again" — the shape the one-shot plan was configured in.
    await clearQuotaBurnJobCompletion('grok');
    expect(Object.keys(onDisk())).toEqual(['claude:a']);
  });

  it('refuses to clear anything without a family', async () => {
    await expect(clearQuotaBurnJobCompletion(null)).resolves.toBeNull();
    expect(Object.keys(onDisk())).toHaveLength(3);
  });

  it('matches the family on the full key segment, not a bare prefix', async () => {
    // `grok` must not clear a hypothetical `grok-two` family's entries.
    seed({ 'grok:a': '2026-08-01T00:00:00.000Z', 'grokish:a': '2026-08-01T00:00:00.000Z' });
    await clearQuotaBurnJobCompletion('grok');
    expect(Object.keys(onDisk())).toEqual(['grokish:a']);
  });
});

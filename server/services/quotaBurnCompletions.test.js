import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-burn-completions-', extraOverrides: (root) => ({ cos: root }) });
vi.mock('../lib/fileUtils.js', async (importActual) => makeProxy(await importActual()));

const { QUOTA_BURN_BOUNDS, QUOTA_BURN_FAMILIES } = await import('../lib/quotaBurnConfig.js');
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
  it('reads an absent ledger as no completions rather than failing', async () => {
    await expect(getQuotaBurnCompletions()).resolves.toEqual({});
  });

  it('reports an UNREADABLE ledger as null, not as an empty one', async () => {
    // The distinction the whole fail-closed contract rests on. A corrupt file
    // read as `{}` means "nothing has run", which re-dispatches every one-shot
    // job on the plan — and the next write then persists that empty ledger over
    // the completions that survived. Asserted against the real reader because
    // the runner suite mocks this module, so only this test can catch a
    // non-strict read here.
    writeFileSync(LEDGER(), '{"grok:a": ');
    await expect(getQuotaBurnCompletions()).resolves.toBeNull();
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

  it('refuses to write over a ledger it could not read', async () => {
    // Writing here would erase every surviving completion and put the whole
    // one-shot plan back into the rotation.
    writeFileSync(LEDGER(), 'not json at all');
    await expect(recordQuotaBurnJobCompletion('grok', 'job-1', { now: NOW })).resolves.toBeNull();
    expect(readFileSync(LEDGER(), 'utf8')).toBe('not json at all');
  });

  it('prunes the oldest entries only, keeping more than a live plan can hold', async () => {
    // The cap exists so the file cannot grow by one dead key per deleted job
    // forever. It must never evict a LIVE key — that would put a spent job back
    // into the rotation behind the user's back — so it stays at twice the keys a
    // maxed-out plan can produce, DERIVED from the family list and the job cap
    // rather than written down (a literal stops covering a live plan the moment
    // either constant grows).
    const liveMax = QUOTA_BURN_FAMILIES.length * QUOTA_BURN_BOUNDS.jobsPerFamily.max;
    const limit = liveMax * 2;
    const seeded = limit + 40;
    seed(Object.fromEntries(Array.from({ length: seeded }, (_, index) => [
      `grok:old-${index}`, new Date(NOW - (seeded - index) * 60_000).toISOString(),
    ])));
    await recordQuotaBurnJobCompletion('grok', 'fresh', { now: NOW });
    const kept = onDisk();
    expect(Object.keys(kept)).toHaveLength(limit);
    expect(limit).toBeGreaterThan(liveMax);
    expect(kept['grok:fresh']).toBe(new Date(NOW).toISOString());
    // Oldest first out: `old-0` is the furthest back, the last index the newest.
    expect(kept['grok:old-0']).toBeUndefined();
    expect(kept[`grok:old-${seeded - 1}`]).toBeDefined();
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

  it('skips the write entirely when the family has nothing to re-arm', async () => {
    // Re-arm-all on a plan that never ran is the common case; a rewrite that
    // changes nothing is pure I/O.
    const before = readFileSync(LEDGER(), 'utf8');
    await expect(clearQuotaBurnJobCompletion('codex')).resolves.toBeNull();
    expect(readFileSync(LEDGER(), 'utf8')).toBe(before);
  });

  it('matches the family on the full key segment, not a bare prefix', async () => {
    // `grok` must not clear a hypothetical `grok-two` family's entries.
    seed({ 'grok:a': '2026-08-01T00:00:00.000Z', 'grokish:a': '2026-08-01T00:00:00.000Z' });
    await clearQuotaBurnJobCompletion('grok');
    expect(Object.keys(onDisk())).toEqual(['grokish:a']);
  });
});

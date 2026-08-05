import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { liftDispatchCaps } from './226-quota-burn-unlimited-dispatch-cap.js';
import { normalizeQuotaBurnConfig, QUOTA_BURN_UNLIMITED_DISPATCHES } from '../../server/lib/quotaBurnConfig.js';

const family = (overrides = {}) => ({
  enabled: true,
  providerId: null,
  scope: null,
  resetWithinHours: 24,
  reservePercent: 0,
  maxDispatchesPerWindow: 5,
  priority: 0,
  jobs: [],
  ...overrides,
});

describe('liftDispatchCaps', () => {
  it('rewrites the old default of 5 to the unlimited sentinel', () => {
    const { config, lifted } = liftDispatchCaps({ enabled: true, families: { grok: family() } });
    expect(lifted).toEqual(['grok']);
    expect(config.families.grok.maxDispatchesPerWindow).toBe(QUOTA_BURN_UNLIMITED_DISPATCHES);
    // Everything else about the family survives verbatim.
    expect(config.families.grok).toMatchObject({ enabled: true, resetWithinHours: 24, priority: 0 });
  });

  it('leaves a cap the user chose over the default alone', () => {
    const { config, lifted } = liftDispatchCaps({
      families: { claude: family({ maxDispatchesPerWindow: 2 }), codex: family({ maxDispatchesPerWindow: 50 }) },
    });
    expect(lifted).toEqual([]);
    expect(config.families.claude.maxDispatchesPerWindow).toBe(2);
    expect(config.families.codex.maxDispatchesPerWindow).toBe(50);
  });

  it('lifts only the families still on the default, in a mixed plan', () => {
    const { config, lifted } = liftDispatchCaps({
      families: { claude: family(), codex: family({ maxDispatchesPerWindow: 3 }), agy: family() },
    });
    expect(lifted).toEqual(['claude', 'agy']);
    expect(config.families.codex.maxDispatchesPerWindow).toBe(3);
  });

  it('reports no change on a config with no families block', () => {
    const config = { enabled: false };
    expect(liftDispatchCaps(config)).toEqual({ config, lifted: [] });
  });

  it('produces a config the normalizer keeps as unlimited', () => {
    // The sentinel sits below the field's own minimum, so a generic clamp would
    // fold it back up to 1 and silently reinstate a cap — guard against that
    // regression from the migration's side too.
    const { config } = liftDispatchCaps({ enabled: true, families: { grok: family() } });
    expect(normalizeQuotaBurnConfig(config).families.grok.maxDispatchesPerWindow)
      .toBe(QUOTA_BURN_UNLIMITED_DISPATCHES);
  });
});

describe('migration 226 up()', () => {
  let rootDir;
  const configPath = () => join(rootDir, 'data', 'cos', 'quota-burn.json');
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-226-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it('no-ops when the install has never written a burn plan', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-config' });
  });

  it('no-ops on an unparseable config rather than throwing the boot migration run', async () => {
    await writeFile(configPath(), 'not json');
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-config' });
  });

  it('lifts a stored plan that still carries the old default', async () => {
    await writeFile(configPath(), JSON.stringify({ enabled: true, families: { grok: family() } }));

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, lifted: ['grok'] });

    const after = JSON.parse(await readFile(configPath(), 'utf-8'));
    expect(after.families.grok.maxDispatchesPerWindow).toBe(QUOTA_BURN_UNLIMITED_DISPATCHES);
  });

  it('is idempotent — a second run leaves the file byte-identical', async () => {
    await writeFile(configPath(), JSON.stringify({ enabled: true, families: { grok: family() } }));

    await migration.up({ rootDir });
    const first = await readFile(configPath(), 'utf-8');
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ reason: 'already-lifted' });
    expect(await readFile(configPath(), 'utf-8')).toBe(first);
  });
});

import { describe, expect, it, vi } from 'vitest';

const existing = {
  id: 'territory',
  account_id: 'account',
  slug: 'old-art',
  label: 'Art',
  is_owned: true,
  monitoring_enabled: true,
  inherit_account_rules: true,
  rules: {},
  remote_settings: { ownershipVerified: true, name: 'old-art' },
  remote_refreshed_at: new Date(),
};
const query = vi.fn(async (sql, params) => {
  if (sql.startsWith('SELECT * FROM stacker_news_territories')) return { rows: [existing] };
  if (sql.startsWith('UPDATE stacker_news_territories')) return { rows: [{
    ...existing,
    slug: params[1],
    remote_settings: params[7],
    remote_refreshed_at: params[8],
  }] };
  return { rows: [] };
});
vi.mock('../lib/db.js', () => ({ query, withTransaction: vi.fn() }));
vi.mock('../lib/vaultCrypto.js', () => ({ decryptValue: vi.fn(), encryptValue: vi.fn(), ensureVaultKey: vi.fn() }));
vi.mock('../integrations/stackerNews/index.js', () => ({ executeStackerNewsOperation: vi.fn(), stackerNewsCapabilities: {} }));

const { updateTerritory } = await import('./stackerNews.js');

describe('Stacker News territory ownership evidence', () => {
  it('clears remote evidence when the configured slug changes', async () => {
    const territory = await updateTerritory(existing.id, { slug: 'new-art' });
    expect(territory.remoteSettings).toEqual({});
    expect(territory.remoteRefreshedAt).toBeNull();
  });
});

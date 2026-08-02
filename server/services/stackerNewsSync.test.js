import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountId = '00000000-0000-4000-8000-000000000001';
const territoryId = '00000000-0000-4000-8000-000000000002';
const query = vi.fn(async (sql) => {
  if (sql.startsWith('SELECT * FROM stacker_news_accounts')) return { rows: [{ id: accountId, label: 'Example', username: 'example_user', enabled: true, monitoring_enabled: false, monitoring_interval_minutes: 30, analysis_enabled: false, text_model: '', vision_model: '', rules: {}, policy_version: 'v1' }] };
  if (sql.startsWith('SELECT api_key_enc')) return { rows: [{ api_key_enc: 'ciphertext' }] };
  if (sql.startsWith('SELECT * FROM stacker_news_territories')) return { rows: [{ id: territoryId, account_id: accountId, slug: 'art', label: 'Art', is_owned: true, monitoring_enabled: true, inherit_account_rules: true, rules: {}, remote_settings: {} }] };
  if (sql.startsWith('SELECT content_hash')) return { rows: [] };
  if (sql.includes('INSERT INTO stacker_news_items')) return { rows: [{ id: '00000000-0000-4000-8000-000000000003', account_id: accountId, territory_id: territoryId, remote_id: '42', kind: 'post', author_name: 'artist', title: 'Example work', body: 'A post', source_url: 'https://stacker.news/items/42', image_urls: [], content_hash: 'hash', received_at: new Date() }] };
  return { rows: [], rowCount: 1 };
});
const executeStackerNewsOperation = vi.fn(async (name, input) => {
  if (name === 'me') return { me: { id: 'owner-1', name: 'example_user' } };
  if (name === 'sub') return { sub: { name: 'art', userId: 'owner-1' } };
  if (name === 'items' && !input.cursor) return { items: { cursor: 'page-2', items: [{ id: '42', title: 'Example work', text: 'A post', user: { name: 'artist' } }] } };
  return { items: { cursor: null, items: [] } };
});
vi.mock('../lib/db.js', () => ({ query, withTransaction: vi.fn() }));
vi.mock('../lib/vaultCrypto.js', () => ({ decryptValue: () => 'api-key', encryptValue: vi.fn(), ensureVaultKey: vi.fn() }));
vi.mock('../integrations/stackerNews/index.js', () => ({ executeStackerNewsOperation, stackerNewsCapabilities: {} }));
const { syncAccount } = await import('./stackerNews.js');

describe('Stacker News sync', () => {
  beforeEach(() => {
    query.mockClear();
    executeStackerNewsOperation.mockClear();
  });

  it('paginates named reads, verifies ownership, and ingests without analyzing when analysis is off', async () => {
    await expect(syncAccount(accountId, { force: true })).resolves.toMatchObject({ ingested: 1, analyzed: 0 });
    const itemCalls = executeStackerNewsOperation.mock.calls.filter(([name]) => name === 'items');
    expect(itemCalls).toHaveLength(2);
    expect(itemCalls[0][1]).toMatchObject({ sub: 'art', cursor: null });
    expect(itemCalls[1][1]).toMatchObject({ sub: 'art', cursor: 'page-2' });
    expect(query.mock.calls.some(([sql, params]) => sql.startsWith('UPDATE stacker_news_territories') && params[1].ownershipVerified === true)).toBe(true);
  });

  it('honors a territory monitoring opt-in when account monitoring is off', async () => {
    await expect(syncAccount(accountId)).resolves.toMatchObject({ skipped: false, ingested: 1 });
    expect(executeStackerNewsOperation).toHaveBeenCalledWith('sub', expect.objectContaining({ name: 'art' }), 'api-key');
  });
});

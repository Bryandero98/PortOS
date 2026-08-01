import { describe, expect, it, vi } from 'vitest';

const query = vi.fn(async (sql, params) => {
  if (!sql.includes('INSERT INTO stacker_news_items')) return { rows: [] };
  return {
    rows: [{
      id: params[0], account_id: params[1], territory_id: params[2], remote_id: params[3], kind: params[4],
      author_name: params[5], title: params[6], body: params[7], source_url: params[8], image_urls: params[9],
      content_hash: params[10], remote_created_at: params[11], remote_updated_at: params[12],
    }],
  };
});

vi.mock('../lib/db.js', () => ({ query, withTransaction: vi.fn() }));
vi.mock('../lib/vaultCrypto.js', () => ({ decryptValue: vi.fn(), encryptValue: vi.fn(), ensureVaultKey: vi.fn() }));
vi.mock('../integrations/stackerNews/index.js', () => ({ executeStackerNewsOperation: vi.fn(), stackerNewsCapabilities: {} }));

const { ingestItem } = await import('./stackerNews.js');

describe('Stacker News content snapshots', () => {
  it('hashes the complete bounded body while model input remains separately capped', async () => {
    const prefix = 'a'.repeat(8_100);
    const first = await ingestItem({ accountId: 'account', remoteId: '1', kind: 'post', body: `${prefix}first-tail` });
    const second = await ingestItem({ accountId: 'account', remoteId: '2', kind: 'post', body: `${prefix}second-tail` });
    expect(first.contentHash).not.toBe(second.contentHash);
    expect(first.body).toHaveLength(prefix.length + 'first-tail'.length);
  });

  it('bounds remotely sourced content before persistence and hashing', async () => {
    const item = await ingestItem({ accountId: 'account', remoteId: '3', kind: 'post', title: 't'.repeat(2_100), body: 'b'.repeat(41_000) });
    expect(item.title).toHaveLength(2_000);
    expect(item.body).toHaveLength(40_000);
  });
});

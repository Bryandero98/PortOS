import { describe, expect, it, vi } from 'vitest';
import { up } from './002-stacker-news-safety-boundaries.js';

describe('Stacker News safety-boundary migration', () => {
  it('moves legacy ciphertext before dropping the account column and backfills provenance', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ present: true }] }).mockResolvedValue({ rows: [] }) };
    await up(client);
    const statements = client.query.mock.calls.map(([sql]) => sql.trim());
    expect(statements.findIndex((sql) => sql.startsWith('INSERT INTO stacker_news_credentials'))).toBeLessThan(statements.findIndex((sql) => sql.startsWith('ALTER TABLE stacker_news_accounts DROP')));
    expect(statements.some((sql) => sql.includes("idempotency_key='legacy:'"))).toBe(true);
    expect(statements.at(-1)).toContain('idempotency_key SET NOT NULL');
  });

  it('does not reference the removed account column on a fresh install', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ present: false }] }).mockResolvedValue({ rows: [] }) };
    await up(client);
    expect(client.query.mock.calls.map(([sql]) => sql).some((sql) => sql.includes('DROP COLUMN api_key_enc'))).toBe(false);
  });
});

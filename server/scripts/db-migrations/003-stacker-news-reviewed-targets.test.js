import { describe, expect, it, vi } from 'vitest';
import { up } from './003-stacker-news-reviewed-targets.js';

describe('Stacker News reviewed-target migration', () => {
  it('backfills target snapshots and limits idempotency to active actions', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await up({ query });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes("'username', ac.username"))).toBe(true);
    expect(statements).toContain('DROP INDEX IF EXISTS idx_stacker_news_actions_idempotency_key');
    expect(statements.at(-1)).toContain("WHERE state IN ('pending_review','approved','executing')");
  });
});

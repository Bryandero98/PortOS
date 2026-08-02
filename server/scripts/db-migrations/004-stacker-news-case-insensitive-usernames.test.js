import { describe, expect, it, vi } from 'vitest';
import { up } from './004-stacker-news-case-insensitive-usernames.js';

describe('Stacker News username identity migration', () => {
  it('enforces case-insensitive uniqueness at the database boundary', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await up({ query });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LOWER(username)'));
  });
});

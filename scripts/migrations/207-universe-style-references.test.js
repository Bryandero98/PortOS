import { describe, expect, it, vi } from 'vitest';
import { up } from './207-universe-style-references.js';

describe('migration 207 — universe style references', () => {
  it('registers the lazy JSONB migration without touching user data', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(up()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('lazy JSONB backfill'));
    log.mockRestore();
  });
});

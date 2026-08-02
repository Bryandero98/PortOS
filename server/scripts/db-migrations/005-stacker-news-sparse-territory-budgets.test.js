import { describe, expect, it, vi } from 'vitest';
import { up } from './005-stacker-news-sparse-territory-budgets.js';

describe('Stacker News sparse territory budget migration', () => {
  it('removes only the generated default budget shape', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await up({ query });
    expect(query.mock.calls[0][0]).toContain("rules=rules-'actionBudget'");
    expect(query.mock.calls[0][0]).toContain('"maxPerDay":12');
  });
});

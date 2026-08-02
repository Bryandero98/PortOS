import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToUrlPinned = vi.fn();
vi.mock('./browserService.js', () => ({ navigateToUrlPinned }));
const { openStackerNewsHandoff } = await import('./stackerNewsBrowser.js');

describe('Stacker News CDP handoff', () => {
  beforeEach(() => navigateToUrlPinned.mockReset());

  it('uses fixed Stacker News URLs and blocks an identity mismatch before opening a destination', async () => {
    navigateToUrlPinned.mockResolvedValue({ id: 'page-1', url: 'https://stacker.news', evalResult: { username: 'wrong_user' } });
    await expect(openStackerNewsHandoff({ kind: 'item', value: '42', expectedUsername: 'example_user' })).rejects.toThrow('not the selected account');
    expect(navigateToUrlPinned).toHaveBeenCalledTimes(1);
    expect(navigateToUrlPinned.mock.calls[0][0]).toBe('https://stacker.news');
    expect(navigateToUrlPinned.mock.calls[0][1].evaluateExpression).toContain('__NEXT_DATA__');
  });

  it('opens only an internally constructed item URL after identity verification', async () => {
    navigateToUrlPinned
      .mockResolvedValueOnce({ id: 'identity', url: 'https://stacker.news', evalResult: { username: 'example_user' } })
      .mockResolvedValueOnce({ id: 'item', url: 'https://stacker.news/items/42' });
    await expect(openStackerNewsHandoff({ kind: 'item', value: '42', expectedUsername: 'example_user' })).resolves.toMatchObject({ pageId: 'item' });
    expect(navigateToUrlPinned.mock.calls[1][0]).toBe('https://stacker.news/items/42');
    expect(navigateToUrlPinned.mock.calls[1][1]).not.toHaveProperty('evaluateExpression');
  });
});

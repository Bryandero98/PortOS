import { beforeEach, describe, expect, it, vi } from 'vitest';

const schedule = vi.fn();
const cancel = vi.fn();
const listAccounts = vi.fn();
const getAccount = vi.fn();
const syncAccount = vi.fn();
vi.mock('./eventScheduler.js', () => ({ schedule, cancel }));
vi.mock('./stackerNews.js', () => ({ listAccounts, getAccount, syncAccount }));
const { reconcileStackerNewsSchedulers, stopStackerNewsSchedulers } = await import('./stackerNewsScheduler.js');

describe('Stacker News scheduler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only arms explicitly enabled monitoring accounts and does not sync at registration', async () => {
    listAccounts.mockResolvedValue([
      { id: 'enabled', enabled: true, monitoringEnabled: true, monitoringIntervalMinutes: 15 },
      { id: 'quiet', enabled: true, monitoringEnabled: false, monitoringIntervalMinutes: 15 },
    ]);
    await expect(reconcileStackerNewsSchedulers()).resolves.toBe(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({ id: 'stacker-news-sync:enabled', type: 'interval', intervalMs: 900_000 });
    expect(syncAccount).not.toHaveBeenCalled();
    stopStackerNewsSchedulers();
  });
});

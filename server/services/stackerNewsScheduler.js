import { cancel, schedule } from './eventScheduler.js';
import { getAccount, listAccounts, syncAccount } from './stackerNews.js';

const PREFIX = 'stacker-news-sync:';
const registered = new Set();

export async function reconcileStackerNewsSchedulers() {
  for (const id of registered) cancel(id);
  registered.clear();
  const accounts = await listAccounts();
  for (const account of accounts.filter((candidate) => candidate.enabled && candidate.monitoringEnabled)) {
    const id = `${PREFIX}${account.id}`;
    schedule({
      id,
      type: 'interval',
      intervalMs: account.monitoringIntervalMinutes * 60_000,
      handler: async () => {
        const current = await getAccount(account.id);
        if (!current?.enabled || !current.monitoringEnabled) return;
        await syncAccount(account.id);
      },
      metadata: { source: 'stackerNewsScheduler', accountId: account.id },
    });
    registered.add(id);
  }
  console.log(`📰 Stacker News scheduler: armed ${registered.size} opted-in account(s)`);
  return registered.size;
}

export function stopStackerNewsSchedulers() {
  for (const id of registered) cancel(id);
  registered.clear();
}

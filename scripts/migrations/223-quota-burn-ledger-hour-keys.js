/**
 * Migration 223 — re-key the quota-burn dispatch ledger to hour-rounded windows.
 *
 * Background:
 *   `data/cos/quota-burn-dispatches.json` counts how many burns a given reset
 *   window has already spent, and `evaluateFamily` refuses to dispatch once a
 *   window's count reaches `maxDispatchesPerWindow`. That cap is the only thing
 *   bounding how much of a user's paid subscription an unattended burn spends.
 *
 *   The key format changed this release. It used to be the EXACT reset epoch:
 *     `${familyId}:${normalizeResetAt(limit).epochMs}`
 *   and is now that epoch rounded to the hour (`windowKey` in
 *   `server/services/quotaBurn.js`), so a provider that reports its reset a few
 *   seconds differently between two reads lands in one bucket instead of two.
 *
 *   Same file, same path, different keys — so without this migration an
 *   upgraded install reads 0 for a window it has already exhausted and burns up
 *   to a full extra cap inside it. Deleting the ledger does NOT fix that: an
 *   absent count reads 0 too. The counts have to be CARRIED, not dropped.
 *
 * What it writes:
 *   `data/cos/quota-burn-dispatches.json`, with every `family:epoch` key
 *   rewritten to `family:hourRoundedEpoch`. Two old keys that round into the
 *   same bucket have their counts SUMMED — the window really did spend both, so
 *   taking the max (or the last writer) would hand back dispatches the user
 *   already paid for.
 *
 *   The release-era `__agentDispatches` sentinel (an object, not a count) is
 *   dropped: nothing in the current code reads it, and leaving it behind means
 *   `Number(ledger[key] || 0)` would see an object if it were ever addressed.
 *
 * Idempotent: an already-hour-rounded key rounds to itself, so a second run is
 * a no-op and the file is left untouched when nothing changes.
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';

const HOUR_MS = 60 * 60 * 1000;
// The release-era per-agent dedupe map. An object under a non-window key.
const LEGACY_AGENT_KEY = '__agentDispatches';

const readJson = async (abs) => {
  const raw = await readFile(abs, 'utf-8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const writeJsonAtomic = async (abs, value) => {
  const tmp = `${abs}.tmp-223`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, abs);
};

/**
 * Fold an old ledger into hour-rounded keys. Pure — exported for the test.
 *
 * @param {object} ledger raw parsed ledger
 * @returns {{ ledger: object, changed: boolean }}
 */
export function rekeyLedger(ledger) {
  const next = {};
  let changed = false;
  for (const [key, value] of Object.entries(ledger)) {
    if (key === LEGACY_AGENT_KEY) { changed = true; continue; }
    const parts = String(key).split(':');
    const epoch = Number(parts.pop());
    const family = parts.join(':');
    const count = Number(value);
    // An unparseable key or a non-numeric count is not something we can safely
    // re-bucket, and dropping it would forgive spend. Carry it verbatim.
    if (!family || !Number.isFinite(epoch) || !Number.isFinite(count)) {
      next[key] = value;
      continue;
    }
    const rounded = `${family}:${Math.round(epoch / HOUR_MS) * HOUR_MS}`;
    if (rounded !== key) changed = true;
    // SUM, don't overwrite: both old buckets were really spent.
    next[rounded] = (next[rounded] || 0) + count;
  }
  return { ledger: next, changed };
}

export default {
  async up({ rootDir }) {
    const ledgerFile = join(rootDir, 'data', 'cos', 'quota-burn-dispatches.json');
    const ledger = await readJson(ledgerFile);
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
      console.log('🔥 migration 223: no quota-burn dispatch ledger — nothing to re-key');
      return { ok: true, reason: 'no-ledger' };
    }

    const { ledger: next, changed } = rekeyLedger(ledger);
    if (!changed) {
      console.log('🔥 migration 223: dispatch ledger already uses hour-rounded window keys');
      return { ok: true, reason: 'already-hourly' };
    }

    await writeJsonAtomic(ledgerFile, next);
    const count = Object.keys(next).length;
    console.log(`🔥 migration 223: re-keyed the quota-burn dispatch ledger to ${count} hour-rounded window(s)`);
    return { ok: true, windows: count };
  },
};

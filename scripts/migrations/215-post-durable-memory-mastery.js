/**
 * Persist durable POST memory mastery metadata.
 *
 * Existing stats that already clear the shipped 3-check / 80% gate are
 * grandfathered as verified so an upgrade cannot erase mastery the user had
 * already demonstrated. Every item also receives the additive retention state
 * used by attestation and its one-time future spot check.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const REL_PATH = 'data/meatspace/post-memory-items.json';
const MIN_ATTEMPTS = 3;
const TARGET_ACCURACY = 0.8;
const SPOT_CHECK_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function clearsMasteryGate(stat) {
  if (typeof stat?.masteredAt === 'string') return true;
  const recent = Array.isArray(stat?.recent) && stat.recent.length ? stat.recent : null;
  const attempts = recent ? recent.length : (Number.isFinite(stat?.attempts) ? stat.attempts : 0);
  const correct = recent
    ? recent.reduce((sum, result) => sum + (result ? 1 : 0), 0)
    : (Number.isFinite(stat?.correct) ? stat.correct : 0);
  return attempts >= MIN_ATTEMPTS && correct / attempts >= TARGET_ACCURACY;
}

function targetStats(item) {
  if (item.id === 'elements-song' && item.content?.elementMap) {
    return Object.keys(item.content.elementMap).map(symbol => item.mastery?.elements?.[symbol]);
  }
  return (item.content?.chunks || []).map(chunk => item.mastery?.chunks?.[chunk.id]);
}

export default {
  async up({ rootDir }) {
    const itemsPath = join(rootDir, REL_PATH);
    const raw = await readFile(itemsPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) return { updated: 0, reason: 'no-file' };

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { updated: 0, reason: 'invalid-json' };
    }
    if (!Array.isArray(data?.items)) return { updated: 0, reason: 'no-items' };

    const fallbackNow = new Date().toISOString();
    let updated = 0;
    for (const item of data.items) {
      if (!item.mastery || typeof item.mastery !== 'object') continue;
      let changed = false;
      if (!item.mastery.retention || typeof item.mastery.retention !== 'object') {
        item.mastery.retention = { status: 'learning' };
        changed = true;
      }
      const masteredAt = item.updatedAt || item.createdAt || fallbackNow;
      for (const bucketName of ['chunks', 'elements']) {
        const bucket = item.mastery[bucketName];
        if (!bucket || typeof bucket !== 'object') continue;
        for (const stat of Object.values(bucket)) {
          if (!stat?.masteredAt && clearsMasteryGate(stat)) {
            stat.masteredAt = masteredAt;
            stat.masterySource = 'verified';
            changed = true;
          }
        }
      }
      const targets = targetStats(item);
      if (item.mastery.retention.status === 'learning'
        && targets.length > 0
        && targets.every(clearsMasteryGate)) {
        const spotCheckAt = new Date(Date.parse(fallbackNow) + SPOT_CHECK_DAYS * DAY_MS).toISOString();
        item.mastery.retention = {
          status: 'mastered',
          masteredAt,
          spotCheckAt,
          spotCheckCompletedAt: null,
          lapsedAt: null,
        };
        item.mastery.overallPct = 100;
        item.schedule = {
          ease: Number.isFinite(item.schedule?.ease) ? item.schedule.ease : 2.5,
          intervalDays: SPOT_CHECK_DAYS,
          nextReview: spotCheckAt,
          lastReviewed: item.schedule?.lastReviewed ?? null,
        };
        changed = true;
      }
      if (changed) updated += 1;
    }

    if (!updated) return { updated: 0, reason: 'already-durable' };
    await writeFile(itemsPath, `${JSON.stringify(data, null, 2)}\n`);
    return { updated };
  },
};

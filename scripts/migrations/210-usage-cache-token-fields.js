/**
 * Seed the prompt-cache token fields and the measured/estimate provenance flag
 * onto existing usage day/month buckets (#3124 Phase 2).
 *
 * Every bucket written before this change holds counts that were ESTIMATED —
 * output from captured stdout, input from the initial prompt length — with no
 * cache-tier counts at all. Stamping them explicitly is what lets the cost
 * report distinguish a measured row from an estimated one instead of leaving
 * older rows unlabeled (and therefore ambiguous).
 *
 * The reader tolerates the absent fields (`?? 0` / `source ?? 'estimate'`), so
 * this migration is a labeling pass, not a correctness prerequisite — but it
 * ships so an install's on-disk shape matches what the code writes, per the
 * distribution rules in CLAUDE.md. The usage store is file-primary and only
 * exists after activity is recorded, so a missing file is a normal no-op.
 */

import { readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

/** Add the additive fields to one provider or model bucket. Returns true if it changed. */
function seedBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return false;
  let changed = false;
  if (typeof bucket.cacheReadTokens !== 'number') {
    bucket.cacheReadTokens = 0;
    changed = true;
  }
  if (typeof bucket.cacheWriteTokens !== 'number') {
    bucket.cacheWriteTokens = 0;
    changed = true;
  }
  if (typeof bucket.source !== 'string') {
    // Pre-existing counts are estimates by definition. A bucket holding no
    // counts yet gets `null` so its first real record decides its provenance.
    const hasCounts = (bucket.tokensIn || 0) > 0 || (bucket.tokensOut || 0) > 0 || (bucket.messages || 0) > 0;
    bucket.source = hasCounts ? 'estimate' : null;
    changed = true;
  }
  return changed;
}

/** Walk a day/month bucket's provider split and its nested per-model splits. */
function seedActivityBucket(bucket) {
  let changed = false;
  for (const providerBucket of Object.values(bucket?.byProvider || {})) {
    changed = seedBucket(providerBucket) || changed;
    for (const modelBucket of Object.values(providerBucket?.byModel || {})) {
      changed = seedBucket(modelBucket) || changed;
    }
  }
  return changed;
}

export async function up({ rootDir }) {
  const usagePath = join(rootDir, 'data', 'usage.json');
  const raw = await readFile(usagePath, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return;

  const usage = JSON.parse(raw);
  let changed = false;
  for (const bucket of Object.values(usage.dailyActivity || {})) {
    changed = seedActivityBucket(bucket) || changed;
  }
  for (const bucket of Object.values(usage.monthlyActivity || {})) {
    changed = seedActivityBucket(bucket) || changed;
  }
  if (!changed) return;

  const tempPath = `${usagePath}.210.tmp`;
  await writeFile(tempPath, `${JSON.stringify(usage, null, 2)}\n`);
  await rename(tempPath, usagePath);
  console.log('📊 Migration 210: seeded usage cache-token fields and estimate provenance');
}

export default { up };

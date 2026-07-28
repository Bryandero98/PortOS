/**
 * Rename usage provider buckets accidentally stored under the JavaScript key
 * "undefined" to the explicit, displayable "unknown" provider id.
 *
 * The usage store is file-primary and exists only after activity is recorded,
 * so a missing file is a normal no-op. Existing unknown buckets are merged
 * additively to preserve every count across partial/manual prior repairs.
 */

import { readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

const mergeObjects = (target, source) => {
  const merged = { ...(target || {}) };
  for (const [key, value] of Object.entries(source || {})) {
    if (key === 'name') continue;
    if (typeof value === 'number') {
      merged[key] = (typeof merged[key] === 'number' ? merged[key] : 0) + value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeObjects(merged[key], value);
    } else if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
};

const renameProviderBucket = (byProvider) => {
  if (!byProvider || typeof byProvider !== 'object' || !Object.hasOwn(byProvider, 'undefined')) {
    return false;
  }
  byProvider.unknown = {
    ...mergeObjects(byProvider.unknown, byProvider.undefined),
    name: 'Unknown provider'
  };
  delete byProvider.undefined;
  return true;
};

export async function up({ rootDir }) {
  const usagePath = join(rootDir, 'data', 'usage.json');
  const raw = await readFile(usagePath, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return;

  const usage = JSON.parse(raw);
  let changed = renameProviderBucket(usage.byProvider);
  for (const bucket of Object.values(usage.dailyActivity || {})) {
    changed = renameProviderBucket(bucket?.byProvider) || changed;
  }
  for (const bucket of Object.values(usage.monthlyActivity || {})) {
    changed = renameProviderBucket(bucket?.byProvider) || changed;
  }
  if (!changed) return;

  const tempPath = `${usagePath}.208.tmp`;
  await writeFile(tempPath, `${JSON.stringify(usage, null, 2)}\n`);
  await rename(tempPath, usagePath);
  console.log('📊 Migration 208: renamed undefined usage providers to unknown');
}

export default { up };

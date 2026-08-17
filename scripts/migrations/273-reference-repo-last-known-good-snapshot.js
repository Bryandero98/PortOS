/**
 * Migration 273 — initialize reference-repo stale snapshot fields.
 *
 * Reference repos are stored inline in data/apps.json. Older entries lack the
 * explicit null used to distinguish “no successful snapshot yet” from a
 * malformed snapshot, so initialize only the missing field and preserve every
 * user-managed reference value byte-for-byte otherwise.
 */

import { readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

const readJson = async (path) => {
  const raw = await readFile(path, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const writeJsonAtomic = async (path, value) => {
  const temporaryPath = `${path}.tmp-273`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporaryPath, path);
};

export default {
  async up({ rootDir }) {
    const appsPath = join(rootDir, 'data', 'apps.json');
    const data = await readJson(appsPath);
    if (!data?.apps || typeof data.apps !== 'object') {
      return { ok: true, reason: 'no-apps', updated: 0 };
    }

    let updated = 0;
    for (const app of Object.values(data.apps)) {
      if (!Array.isArray(app?.referenceRepos)) continue;
      app.referenceRepos = app.referenceRepos.map((ref) => {
        if (!ref || typeof ref !== 'object' || Object.hasOwn(ref, 'lastKnownGoodSnapshot')) return ref;
        updated += 1;
        return { ...ref, lastKnownGoodSnapshot: null };
      });
    }
    if (updated > 0) await writeJsonAtomic(appsPath, data);
    return { ok: true, reason: updated > 0 ? 'initialized' : 'already-current', updated };
  },
};

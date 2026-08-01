/** Backfill the consecutive-pass counter used to end skill review schedules. */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const REL_PATH = 'data/meatspace/post-review-schedule.json';

export default {
  async up({ rootDir }) {
    const schedulePath = join(rootDir, REL_PATH);
    const raw = await readFile(schedulePath, 'utf-8').catch((err) => {
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
    if (!data?.skills || typeof data.skills !== 'object') return { updated: 0, reason: 'no-skills' };

    let updated = 0;
    for (const entry of Object.values(data.skills)) {
      if (Number.isInteger(entry?.verificationPasses) && entry.verificationPasses >= 0) continue;
      entry.verificationPasses = 0;
      updated += 1;
    }
    if (!updated) return { updated: 0, reason: 'already-counted' };

    await writeFile(schedulePath, `${JSON.stringify(data, null, 2)}\n`);
    return { updated };
  },
};

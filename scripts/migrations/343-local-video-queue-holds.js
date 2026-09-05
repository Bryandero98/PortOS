/** Add local runtime holds without changing or re-enqueueing any stored job. */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { writeJsonAtomic } from './_lib.js';

export default {
  async up({ rootDir }) {
    const file = join(rootDir, 'data', 'media-jobs.json');
    const raw = await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) return { updated: 0 };
    const envelope = JSON.parse(raw);
    if (!envelope || !Array.isArray(envelope.jobs)) throw new Error('Invalid media jobs envelope');
    if (Object.hasOwn(envelope, 'videoHolds')) return { updated: 0 };
    await writeJsonAtomic(file, { ...envelope, videoHolds: [] });
    return { updated: 1 };
  },
};

/**
 * Add the never-before-shipped MiniMax H3 CUDA profile to existing Windows
 * registries. Fresh installs receive it from data.reference/media-models.json.
 *
 * Same reason migration 242 exists for the macOS MLX profile: a registry whose
 * `_shippedDefaults.video.windows` snapshot predates this entry has no record
 * of it, and `appendNewlyShippedEntries` in mediaModels.js reads a recorded id
 * as "the user deleted this". That mechanism delivers the new row correctly on
 * its own — this migration only covers the install whose snapshot was written
 * by 242's legacy bootstrap, which unions the user's ids with the built-in set.
 *
 * (242 now pins that union to the ids IT shipped with rather than re-reading
 * `data.reference`, so it can no longer record this entry as already-shipped.
 * This migration is the belt to that braces: it runs after 242 and appends the
 * row when nothing has recorded it.)
 */

import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { atomicWrite } from '../../server/lib/fileUtils.js';

const REL_PATH = 'data/media-models.json';
const CUDA_ID = 'minimax_h3_cuda';
const REFERENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'data.reference', 'media-models.json',
);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parseJson = (raw, label) => {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot migrate ${label}: invalid JSON (${err.message})`, { cause: err });
  }
};

export default {
  async up({ rootDir }) {
    const path = join(rootDir, REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) return;

    const config = parseJson(raw, REL_PATH);
    const windows = Array.isArray(config?.video?.windows) ? config.video.windows : null;
    if (!windows) return;

    const reference = parseJson(await readFile(REFERENCE_PATH, 'utf-8'), 'data.reference/media-models.json');
    const referenceWindows = Array.isArray(reference?.video?.windows) ? reference.video.windows : [];
    const cuda = referenceWindows.find((entry) => entry?.id === CUDA_ID);
    if (!cuda) throw new Error(`Cannot migrate ${REL_PATH}: shipped ${CUDA_ID} reference is missing`);

    const shippedWindows = isObject(config._shippedDefaults?.video)
      && Array.isArray(config._shippedDefaults.video.windows)
      ? config._shippedDefaults.video.windows
      : null;
    const wasAlreadyShipped = shippedWindows?.includes(CUDA_ID) === true;
    const existing = windows.find((entry) => entry?.id === CUDA_ID);
    let changed = false;

    // A recorded-but-missing id is a user deletion and stays deleted. An
    // existing row may be user-customized and is never overwritten.
    if (!existing && !wasAlreadyShipped) {
      windows.push(structuredClone(cuda));
      changed = true;
    }

    // Record it so the load-time appender doesn't offer it a second time after
    // a deliberate deletion. A registry with no snapshot key at all is left
    // alone — 242 owns creating it, and writing a partial one here would make
    // every historically deleted default look new on the next load.
    if (shippedWindows && windows.some((entry) => entry?.id === CUDA_ID) && !wasAlreadyShipped) {
      shippedWindows.push(CUDA_ID);
      changed = true;
    }

    if (changed) {
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: added the MiniMax H3 CUDA video profile`);
    }
  },
};

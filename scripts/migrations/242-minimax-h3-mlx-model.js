/**
 * Add the never-before-shipped MiniMax H3 MLX profile to existing macOS
 * registries. Fresh installs receive it from data.reference/media-models.json.
 *
 * Registries that predate `_shippedDefaults` need a migration: their normal
 * bootstrap deliberately treats every current default id as already shipped
 * to preserve historical deletions, which would otherwise hide this new row.
 * The bootstrap snapshot built here mirrors mediaModels.js exactly, while the
 * explicit H3 append is the one new-model exception for this release.
 */

import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { atomicWrite } from '../../server/lib/fileUtils.js';

const REL_PATH = 'data/media-models.json';
const H3_ID = 'minimax_h3_8bit';
const REFERENCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'data.reference', 'media-models.json',
);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ids = (entries) => (Array.isArray(entries)
  ? entries.map((entry) => entry?.id).filter((id) => typeof id === 'string')
  : []);
const bootstrapIds = (userEntries, defaultEntries) => (Array.isArray(userEntries)
  ? [...new Set([...ids(userEntries), ...ids(defaultEntries)])]
  : []);

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
    const macos = Array.isArray(config?.video?.macos) ? config.video.macos : null;
    if (!macos) return;

    const reference = parseJson(await readFile(REFERENCE_PATH, 'utf-8'), 'data.reference/media-models.json');
    const referenceMacos = Array.isArray(reference?.video?.macos) ? reference.video.macos : [];
    const h3 = referenceMacos.find((entry) => entry?.id === H3_ID);
    if (!h3) throw new Error(`Cannot migrate ${REL_PATH}: shipped ${H3_ID} reference is missing`);

    const shippedRoot = isObject(config._shippedDefaults) ? config._shippedDefaults : null;
    const shippedVideo = isObject(shippedRoot?.video) ? shippedRoot.video : null;
    const shippedMacos = Array.isArray(shippedVideo?.macos) ? shippedVideo.macos : null;
    const wasAlreadyShipped = shippedMacos?.includes(H3_ID) === true;
    const existing = macos.find((entry) => entry?.id === H3_ID);
    let changed = false;

    // A recorded-but-missing id is a user deletion and stays deleted. An
    // existing row may be user-customized and is never overwritten.
    if (!existing && !wasAlreadyShipped) {
      macos.push(structuredClone(h3));
      changed = true;
    }

    if (shippedMacos) {
      if (macos.some((entry) => entry?.id === H3_ID) && !shippedMacos.includes(H3_ID)) {
        shippedMacos.push(H3_ID);
        changed = true;
      }
    } else {
      // Once we introduce the snapshot key, populate it with the same union
      // mediaModels.js would use for a legacy registry. A partial [H3]-only
      // snapshot would make every historically deleted default look new and
      // silently repopulate the user's curated list on the next load.
      const nextRoot = shippedRoot || {};
      const nextVideo = shippedVideo || {};
      nextVideo.macos = bootstrapIds(macos, referenceMacos);
      if (!shippedVideo) {
        nextVideo.windows = bootstrapIds(config.video.windows, reference?.video?.windows);
      }
      nextRoot.video = nextVideo;
      config._shippedDefaults = nextRoot;
      changed = true;
    }

    if (changed) {
      await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`📝 ${REL_PATH}: added the MiniMax H3 MLX video profile`);
    }
  },
};

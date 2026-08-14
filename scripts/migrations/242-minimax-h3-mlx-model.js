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

// The built-in video model ids as of the release that introduced this
// migration (commit ffac284f9), used for the `_shippedDefaults` bootstrap union
// below. Frozen deliberately: this is a historical fact about what this
// migration delivered, not a live view of the catalog, so it must never be
// re-read from `data.reference/media-models.json`.
const SHIPPED_AT_242 = Object.freeze({
  macos: Object.freeze([
    'ltx2_unified', 'ltx23_unified', 'ltx23_distilled_q4', 'ltx23_dgrauet_q4',
    'ltx23_dgrauet_q8', 'minimax_h3_8bit', 'wan22_ti2v_5b', 'wan22_t2v_a14b',
    'wan22_i2v_a14b', 'wan22_t2v_a14b_lightning', 'wan22_i2v_a14b_lightning',
    'hunyuan_video',
  ]),
  windows: Object.freeze(['ltx_video']),
});

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
      //
      // The union is against the id set THIS MIGRATION shipped with, pinned
      // below — never against today's `data.reference`. Re-deriving it meant a
      // model added to the catalog *after* this migration got recorded as
      // "already shipped" the first time a legacy install ran it, and was then
      // permanently suppressed: `appendNewlyShippedEntries` reads a recorded id
      // as "the user deleted this", so the entry would never appear and no
      // later migration could tell the difference. Adding a default must not
      // retroactively change what this migration claims to have delivered.
      const nextRoot = shippedRoot || {};
      const nextVideo = shippedVideo || {};
      nextVideo.macos = bootstrapIds(macos, SHIPPED_AT_242.macos.map((id) => ({ id })));
      if (!shippedVideo) {
        nextVideo.windows = bootstrapIds(config.video.windows, SHIPPED_AT_242.windows.map((id) => ({ id })));
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

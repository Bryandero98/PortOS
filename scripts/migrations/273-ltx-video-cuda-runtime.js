/**
 * Correct the legacy LTX-Video 0.9.5 CUDA entry's runtime marker. It was
 * stored in the CUDA bucket but incorrectly named the Apple-only MLX runtime,
 * which sent Linux renders down an unavailable path before they could spawn.
 */

import { VIDEO_BUCKET_CUDA, readVideoBucket } from '../../server/lib/mediaModelBuckets.js';
import { readMediaRegistryConfig, writeMediaRegistry } from './_lib.js';

const REL_PATH = 'data/media-models.json';

const isLegacyLtx = (entry) => (
  entry?.id === 'ltx_video'
  && (entry.runtime === undefined || entry.runtime === 'mlx_video')
  && entry.repo === undefined
);

export default {
  async up({ rootDir }) {
    const { ok, config, path } = await readMediaRegistryConfig({ rootDir });
    if (!ok) return;

    const cuda = readVideoBucket(config?.video, VIDEO_BUCKET_CUDA);
    if (!Array.isArray(cuda)) return;
    let changed = false;
    for (const entry of cuda) {
      if (!isLegacyLtx(entry)) continue;
      entry.runtime = 'cuda_video';
      changed = true;
    }
    if (!changed) return;

    await writeMediaRegistry(path, config);
    console.log(`📝 ${REL_PATH}: corrected LTX-Video's CUDA runtime marker`);
  },
};

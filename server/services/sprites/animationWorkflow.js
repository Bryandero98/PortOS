/** Shared per-record animation serialization and reference-key resolution. */

import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';

const animationWriteTail = createKeyCachedQueue();

// Walk and every named action mutate adjacent records under one sprite. Keep
// their write tail shared so a scanner approval cannot race a walk revision.
export const withAnimationWriteTail = (recordId, fn) => animationWriteTail(recordId, fn);

// manifest → record is the frozen chroma-key precedence for every animation
// track. A run's own key is the strongest provenance rung while packaging.
export const resolveChromaKey = ({ manifest, record, run } = {}) => (
  run?.chromaKey || manifest?.chromaKey || record?.chromaKey || null
);

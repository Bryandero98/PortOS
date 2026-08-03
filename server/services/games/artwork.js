/**
 * Publish gallery artwork into a managed game's repository with provenance and
 * occupied/diverged-destination guards (shared lane: publishCore.js).
 */

import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { publishGameBinding, readIfPresent } from './publishCore.js';

export function publishGameArtwork(gameId, bindingId, { acknowledgeOverwrite = false } = {}) {
  return publishGameBinding(gameId, bindingId, {
    acknowledgeOverwrite,
    bindingsKey: 'artworkBindings',
    bindingNotFound: 'Artwork binding not found',
    async resolveSourceBytes(binding) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(binding.imageFilename)) {
        throw new ServerError('The bound gallery artwork path is invalid', {
          status: 409,
          code: 'ARTWORK_PATH_INVALID',
        });
      }
      const source = await readIfPresent(join(PATHS.images, binding.imageFilename));
      if (!source) {
        throw new ServerError('The bound gallery artwork is missing', {
          status: 409,
          code: 'ARTWORK_MISSING',
        });
      }
      return source;
    },
  });
}

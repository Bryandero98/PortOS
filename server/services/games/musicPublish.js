/**
 * Publish a bound music track's library audio into a managed game's repository
 * with provenance and occupied/diverged-destination guards (shared lane:
 * publishCore.js). The audio file resolves through the same music library the
 * integrity preflight verifies, so a track the preflight blocks cannot publish.
 */

import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isSafeMusicFilename } from '../pipeline/musicLibrary.js';
import { getTrack } from '../tracks/index.js';
import { publishGameBinding, readIfPresent } from './publishCore.js';

export function publishGameMusic(gameId, bindingId, { acknowledgeOverwrite = false } = {}) {
  return publishGameBinding(gameId, bindingId, {
    acknowledgeOverwrite,
    bindingsKey: 'musicBindings',
    bindingNotFound: 'Music binding not found',
    async resolveSourceBytes(binding) {
      if (!binding.destinationPath) {
        throw new ServerError('Set a game destination for this track before publishing', {
          status: 409,
          code: 'MUSIC_DESTINATION_REQUIRED',
        });
      }
      const track = await getTrack(binding.trackId);
      if (!track) {
        throw new ServerError(`Bound music track no longer exists: ${binding.trackId}`, {
          status: 409,
          code: 'TRACK_MISSING',
        });
      }
      if (!track.audioFilename) {
        throw new ServerError(`Render or upload audio for "${track.title}" before publishing`, {
          status: 409,
          code: 'TRACK_AUDIO_REQUIRED',
        });
      }
      if (!isSafeMusicFilename(track.audioFilename)) {
        throw new ServerError(`The rendered audio path for "${track.title}" is invalid`, {
          status: 409,
          code: 'TRACK_AUDIO_INTEGRITY_FAILED',
        });
      }
      const source = await readIfPresent(join(PATHS.music, track.audioFilename));
      if (!source) {
        throw new ServerError(`The rendered audio for "${track.title}" is missing or unreadable`, {
          status: 409,
          code: 'TRACK_AUDIO_MISSING',
        });
      }
      return source;
    },
  });
}

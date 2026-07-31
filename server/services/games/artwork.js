/**
 * Publish gallery artwork into a managed game's repository with provenance and
 * occupied/diverged-destination guards.
 */

import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { atomicWrite, isPathInsideDir, PATHS } from '../../lib/fileUtils.js';
import { getAppById } from '../apps.js';
import { isDeploying } from '../appDeployer.js';
import { getGame, mutateGame } from './records.js';

const repoPublishTail = createKeyCachedQueue();
const sha256Buffer = (buffer) => createHash('sha256').update(buffer).digest('hex');

const anchorRepoPath = (repoRoot, relPath) => {
  const abs = resolve(repoRoot, relPath);
  if (abs === resolve(repoRoot)
    || relPath.startsWith('/')
    || relPath.includes('\\')
    || !isPathInsideDir(repoRoot, abs)) {
    throw new ServerError('Artwork destination must stay inside the managed app repository', {
      status: 400,
      code: 'INVALID_PUBLISH_PATH',
    });
  }
  return abs;
};

const readIfPresent = (path) => readFile(path).then(
  (buffer) => buffer,
  (error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  },
);

export async function publishGameArtwork(
  gameId,
  bindingId,
  { acknowledgeOverwrite = false } = {},
) {
  const game = await getGame(gameId);
  if (!game) throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  const binding = game.artworkBindings.find((entry) => entry.id === bindingId);
  if (!binding) throw new ServerError('Artwork binding not found', { status: 404, code: 'NOT_FOUND' });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(binding.imageFilename)) {
    throw new ServerError('The bound gallery artwork path is invalid', {
      status: 409,
      code: 'ARTWORK_PATH_INVALID',
    });
  }

  const app = await getAppById(game.appId);
  const repoStat = app?.repoPath ? await stat(app.repoPath).catch(() => null) : null;
  if (!app || !repoStat?.isDirectory()) {
    throw new ServerError('The bound managed app has no accessible repository', {
      status: 409,
      code: 'APP_REPO_MISSING',
    });
  }

  const sourcePath = join(PATHS.images, binding.imageFilename);
  const source = await readIfPresent(sourcePath);
  if (!source) {
    throw new ServerError('The bound gallery artwork is missing', {
      status: 409,
      code: 'ARTWORK_MISSING',
    });
  }
  const sourceSha256 = sha256Buffer(source);
  const repoRoot = resolve(app.repoPath);

  return repoPublishTail(repoRoot, async () => {
    if (isDeploying(app.repoPath)) {
      throw new ServerError(`App ${app.name || app.id} is deploying — retry when it finishes`, {
        status: 409,
        code: 'APP_DEPLOY_IN_PROGRESS',
      });
    }
    const destination = anchorRepoPath(repoRoot, binding.destinationPath);
    const existing = await readIfPresent(destination);
    const existingSha256 = existing ? sha256Buffer(existing) : null;
    const previous = binding.publication?.destinationPath === binding.destinationPath
      ? binding.publication
      : null;
    const occupiedByOtherBytes = existingSha256
      && existingSha256 !== sourceSha256
      && existingSha256 !== previous?.destinationSha256;
    if (occupiedByOtherBytes && !acknowledgeOverwrite) {
      throw new ServerError(
        `${binding.destinationPath} contains bytes PortOS did not publish — confirm the overwrite to replace it.`,
        { status: 409, code: 'PUBLISH_DEST_OCCUPIED' },
      );
    }

    const wrote = existingSha256 !== sourceSha256;
    if (wrote) await atomicWrite(destination, source);
    const publishedAt = new Date().toISOString();
    const updated = await mutateGame(gameId, (current) => {
      if (!current.artworkBindings.some((entry) => entry.id === bindingId)) {
        throw new ServerError('Artwork binding not found', { status: 404, code: 'NOT_FOUND' });
      }
      return {
        ...current,
        artworkBindings: current.artworkBindings.map((entry) => (
          entry.id === bindingId
            ? {
              ...entry,
              publication: {
                sourceSha256,
                destinationSha256: sourceSha256,
                destinationPath: entry.destinationPath,
                publishedAt,
              },
            }
            : entry
        )),
      };
    });
    return {
      game: updated,
      publication: {
        bindingId,
        sourceSha256,
        destinationSha256: sourceSha256,
        destinationPath: binding.destinationPath,
        publishedAt,
        wrote,
      },
    };
  });
}

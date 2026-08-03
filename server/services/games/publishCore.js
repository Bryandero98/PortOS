/**
 * Shared managed-repo publish lane for game asset bindings.
 *
 * Every lane (artwork, music) resolves its own source bytes; this core owns
 * everything the lanes must not drift on: the repo lookup, the path anchor,
 * the occupied/diverged-destination guard behind an explicit overwrite
 * acknowledgement, the mid-deploy refusal, the atomic write, and the SHA-256
 * provenance stamp on the published binding. One queue serializes ALL game
 * publishes per repository, so an artwork and a music publish into the same
 * repo run one-after-another rather than racing.
 */

import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { atomicWrite, isPathInsideDir } from '../../lib/fileUtils.js';
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
    throw new ServerError('Publish destination must stay inside the managed app repository', {
      status: 400,
      code: 'INVALID_PUBLISH_PATH',
    });
  }
  return abs;
};

export const readIfPresent = (path) => readFile(path).then(
  (buffer) => buffer,
  (error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  },
);

export async function publishGameBinding(gameId, bindingId, {
  acknowledgeOverwrite = false,
  bindingsKey,
  bindingNotFound,
  resolveSourceBytes,
}) {
  const game = await getGame(gameId);
  if (!game) throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  const binding = (game[bindingsKey] || []).find((entry) => entry.id === bindingId);
  if (!binding) throw new ServerError(bindingNotFound, { status: 404, code: 'NOT_FOUND' });

  const source = await resolveSourceBytes(binding);
  const sourceSha256 = sha256Buffer(source);

  const app = await getAppById(game.appId);
  const repoStat = app?.repoPath ? await stat(app.repoPath).catch(() => null) : null;
  if (!app || !repoStat?.isDirectory()) {
    throw new ServerError('The bound managed app has no accessible repository', {
      status: 409,
      code: 'APP_REPO_MISSING',
    });
  }
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
      if (!(current[bindingsKey] || []).some((entry) => entry.id === bindingId)) {
        throw new ServerError(bindingNotFound, { status: 404, code: 'NOT_FOUND' });
      }
      return {
        ...current,
        [bindingsKey]: current[bindingsKey].map((entry) => (
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

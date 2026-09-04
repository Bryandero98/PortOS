/**
 * Slotstream weights — the one step of the runtime PortOS did not manage.
 *
 * `slotstreamServerManager.js` owns the process (install / start / stop / logs)
 * and it deliberately refuses to start without a cached checkpoint. Until this
 * module existed, the only answer it could offer was "place a checkpoint
 * directory in ~/.slotstream/models yourself" — a hand-assembled 100 GB+
 * directory, which is a dead end inside an app that manages everything else
 * about the runtime.
 *
 * A download still never happens implicitly. It moves tens of gigabytes and
 * only ever runs from a button the user pressed that names what it will fetch,
 * and a START still never fetches anything — this is its own explicit action.
 *
 * The transfer is PortOS's own resumable HTTP path (`streamResumableDownload`),
 * not a Python helper: Slotstream is a single native binary, and requiring an
 * image-gen venv for a text runtime's weights would be a strange dependency to
 * take on. Each file lands under the checkpoint directory the cache walk reads,
 * so a completed download is servable with no restart.
 */

import { rm, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import {
  assessDownloadPreflight,
  assertDownloadFits,
  partialPathFor,
  siblingDownloadMeta,
  streamResumableDownload,
} from '../lib/downloadPreflight.js';
import { buildHfAuthHeaders, buildHfResolveUrl, fetchHuggingfaceModel } from '../lib/huggingfaceLora.js';
import {
  SLOTSTREAM_CATALOG,
  resolveSlotstreamRepo,
  selectSlotstreamRepoFiles,
  slotstreamCatalogEntry,
  slotstreamModelDirName,
} from '../lib/slotstreamCatalog.js';
import { slotstreamCacheDir } from '../lib/slotstreamModels.js';
import { getHfToken } from './hfToken.js';

export { SLOTSTREAM_CATALOG };

/** Frames are throttled so a fast link can't put one socket emit per chunk on the wire. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * A silent connection is never useful — it holds the one download slot while
 * every later press queues behind it. Generous, because a checkpoint this size
 * legitimately runs for hours while it IS receiving bytes.
 */
const IDLE_STALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SLOTSTREAM_IDLE_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60 * 1000;
})();

/** A metadata lookup that only blocks the confirm modal needs its own bound. */
const METADATA_FETCH_TIMEOUT_MS = 15_000;

/** Downloads in flight, keyed by checkpoint directory. */
const inFlight = new Map();

const cacheDirFor = (cacheDir) => cacheDir || slotstreamCacheDir();

/** The absolute checkpoint directory a repo occupies in the cache. */
export const slotstreamModelPath = (repo, { cacheDir } = {}) =>
  join(cacheDirFor(cacheDir), slotstreamModelDirName(repo));

function requireRepo(model) {
  const repo = resolveSlotstreamRepo(model);
  if (!repo) {
    throw new ServerError(
      `"${model}" is not a Slotstream checkpoint. Pick one from the catalog, or name a Hugging Face repo as owner/name.`,
      { status: 400, code: 'SLOTSTREAM_INVALID_MODEL' },
    );
  }
  return repo;
}

const hfDownloadHttpError = (res) => {
  if (res.status === 401 || res.status === 403) {
    throw new ServerError(
      `Hugging Face rejected the download (${res.status}) — this repo is gated. Accept its license on Hugging Face and add your HF token in Image Gen settings, then retry.`,
      { status: res.status, code: 'HF_AUTH' },
    );
  }
  throw new ServerError(`Hugging Face download failed: ${res.status} ${res.statusText}`, { status: 502, code: 'HF_DOWNLOAD_FAILED' });
};

const fileSize = async (path) => stat(path).then((s) => (s.isFile() ? s.size : 0), () => 0);

/**
 * Whether a file already at `destPath` can be trusted as finished.
 *
 * Only a length matching what the Hub advertises counts. A file of any other
 * length is a dead mid-file write — appending to it would corrupt the shard —
 * and a file whose size the Hub never reported cannot be checked at all, so
 * both are re-fetched rather than assumed complete. The plan and the download
 * loop ask this same question, so what is credited and what is skipped cannot
 * disagree.
 */
const isFinishedOnDisk = async (destPath, expectedBytes) =>
  expectedBytes > 0 && (await fileSize(destPath)) === expectedBytes;

/**
 * What this download would transfer, and what is already here.
 *
 * Two counts, deliberately kept apart. `finishedBytes` is files whose length
 * MATCHES what the Hub advertises — the only evidence a file is done, since a
 * leftover of any other length is a write that died mid-file and gets re-fetched
 * from scratch. `partialBytes` is what a `.partial` can resume from. Both credit
 * against the disk a run still needs (reserving the full repo again would make a
 * nearly-full volume refuse a resume it can actually finish), but only
 * `finishedBytes` may say a checkpoint is already downloaded: a full-size
 * `.partial` is a crash between the last byte and the rename, and calling that
 * "already on disk" would disable the very button that completes it.
 */
async function planRepoDownload({ repo, token, signal, cacheDir }) {
  const model = await fetchHuggingfaceModel(repo, { token, signal, blobs: true });
  const siblings = Array.isArray(model?.siblings) ? model.siblings : [];
  const files = selectSlotstreamRepoFiles(siblings);
  // A repo whose only surviving files are config/tokenizer would otherwise
  // produce a checkpoint directory with no weights in it — which the cache walk
  // would then report as servable, and a start would fail on.
  if (!files.some((file) => file.endsWith('.safetensors'))) {
    throw new ServerError(
      `Hugging Face repo ${repo} publishes no weights PortOS can stream — Slotstream reads .safetensors checkpoints.`,
      { status: 422, code: 'SLOTSTREAM_NO_WEIGHTS' },
    );
  }

  const metaByFile = new Map(
    siblings
      .filter((row) => typeof row?.rfilename === 'string')
      .map((row) => [row.rfilename, siblingDownloadMeta(row)]),
  );
  const modelDir = slotstreamModelPath(repo, { cacheDir });

  let totalBytes = 0;
  let finishedBytes = 0;
  let partialBytes = 0;
  const plan = [];
  for (const file of files) {
    const meta = metaByFile.get(file) || { bytes: 0, sha256: null };
    const destPath = join(modelDir, file);
    // Belt to the name filter's braces: whatever the Hub called this file, the
    // path it resolves to has to stay inside the checkpoint directory.
    if (!resolve(destPath).startsWith(`${resolve(modelDir)}${sep}`)) {
      throw new ServerError(
        `Hugging Face repo ${repo} lists a file whose path escapes the checkpoint directory.`,
        { status: 422, code: 'SLOTSTREAM_UNSAFE_FILENAME' },
      );
    }
    totalBytes += meta.bytes;
    if (await isFinishedOnDisk(destPath, meta.bytes)) finishedBytes += meta.bytes;
    else partialBytes += Math.min(await fileSize(partialPathFor(destPath)), meta.bytes);
    plan.push({ file, destPath, url: buildHfResolveUrl(repo, 'main', file), ...meta });
  }

  return { modelDir, files: plan, totalBytes, finishedBytes, partialBytes };
}

/**
 * Size / destination / free-disk numbers for the confirm step. Starts nothing.
 *
 * `expectedBytes` is the WHOLE checkpoint (what the user is committing to)
 * while the verdict is computed on what is actually left to move, so a resume
 * reads as "Size 123 GB / Still needed 4 GB" rather than being refused on a
 * disk that can finish it.
 */
export async function previewSlotstreamDownload({ model = null, cacheDir } = {}) {
  const repo = requireRepo(model);
  const token = await getHfToken();
  const plan = await planRepoDownload({
    repo,
    token,
    signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
    cacheDir,
  });
  const remaining = Math.max(0, plan.totalBytes - plan.finishedBytes - plan.partialBytes);
  const assessment = await assessDownloadPreflight({ destPath: plan.modelDir, expectedBytes: remaining });

  return {
    kind: 'slotstream',
    ...assessment,
    // The confirm modal reads `expectedBytes` as "Size" and derives "Still
    // needed" from `requiredBytes`; reporting the remainder as the size would
    // hide how large the checkpoint actually is.
    expectedBytes: plan.totalBytes,
    destPath: plan.modelDir,
    repo,
    files: plan.files.length,
    // Finished files only — see planRepoDownload. This flag DISABLES Confirm,
    // so counting a `.partial` here would strand a resumable download.
    alreadyDownloaded: plan.totalBytes > 0 && plan.finishedBytes === plan.totalBytes,
  };
}

/**
 * Download one checkpoint into Slotstream's cache.
 *
 * Never throws for a transfer failure the caller has already streamed progress
 * for: the outcome is a value the route reports. An invalid request (unknown
 * model, a second press while one is running) still throws, because nothing has
 * been streamed yet.
 *
 * @param {{ model?: string|null, cacheDir?: string, onProgress?: (frame: object) => void }} [options]
 */
export async function downloadSlotstreamModel({ model = null, cacheDir, onProgress = () => {} } = {}) {
  const repo = requireRepo(model);
  const modelDir = slotstreamModelPath(repo, { cacheDir });
  // ONE checkpoint at a time, not one per checkpoint: these are 100 GB+ reads of
  // the same disk, and the card renders a single progress bar fed by a single
  // `slotstream:download` event — two concurrent transfers would interleave
  // frames on it and the first terminal frame would tear down the other's bar.
  if (inFlight.size > 0) {
    throw new ServerError(
      inFlight.has(modelDir)
        ? `${repo} is already downloading.`
        : 'Another Slotstream checkpoint is already downloading — PortOS fetches one at a time.',
      { status: 409, code: 'SLOTSTREAM_DOWNLOAD_IN_FLIGHT' },
    );
  }
  // Claim the slot BEFORE the first await: resolving the repo is a round trip,
  // and a second press landing inside that window would clear the check above
  // and start a parallel copy of the same 100 GB+ transfer.
  const state = { repo, controller: new AbortController(), stalled: false };
  inFlight.set(modelDir, state);

  const label = slotstreamCatalogEntry(repo)?.label || repo;
  let lastEmit = 0;
  try {
    const token = await getHfToken();
    const headers = buildHfAuthHeaders(token);
    onProgress({ event: 'start', model: repo, message: `Resolving ${repo} on Hugging Face…` });
    const plan = await planRepoDownload({ repo, token, signal: state.controller.signal, cacheDir });
    const carried = plan.finishedBytes + plan.partialBytes;
    assertDownloadFits(await assessDownloadPreflight({
      destPath: plan.modelDir,
      expectedBytes: Math.max(0, plan.totalBytes - carried),
    }));

    console.log(`⬇️  Slotstream checkpoint download started: ${repo} (${plan.files.length} files, ${plan.totalBytes} bytes)`);
    onProgress({
      event: 'progress',
      model: repo,
      received: carried,
      total: plan.totalBytes,
      message: `Downloading ${label} — ${plan.files.length} files. This is a multi-gigabyte download and can take a while.`,
    });

    // Bytes already accounted for, so the bar reports progress through the whole
    // checkpoint rather than restarting at each file.
    let completedBytes = carried;
    for (const entry of plan.files) {
      if (await isFinishedOnDisk(entry.destPath, entry.bytes)) continue;
      // Anything else at the destination is a dead mid-file write (or a file
      // whose size the Hub never reported, so completeness is unknowable) —
      // a resume would append to the wrong prefix, so start that one over.
      // `force` makes this a no-op when nothing is there.
      await rm(entry.destPath, { force: true }).catch(() => {});

      const resumedFrom = await fileSize(partialPathFor(entry.destPath));
      const { bytes } = await streamResumableDownload({
        url: entry.url,
        headers,
        destPath: entry.destPath,
        expectedSha256: entry.sha256,
        signal: state.controller.signal,
        idleStallTimeoutMs: IDLE_STALL_TIMEOUT_MS,
        onIdleStall: () => {
          state.stalled = true;
          state.controller.abort();
        },
        onHttpError: hfDownloadHttpError,
        onBytes: (received) => {
          const now = Date.now();
          if (now - lastEmit < PROGRESS_INTERVAL_MS) return;
          lastEmit = now;
          onProgress({
            event: 'progress',
            model: repo,
            // Clamped: a file whose size the Hub never reported contributes
            // nothing to `total` but real bytes as it lands, which would
            // otherwise walk the bar past 100%.
            received: Math.min(plan.totalBytes, completedBytes + Math.max(0, received - resumedFrom)),
            total: plan.totalBytes,
            message: `Downloading ${entry.file}`,
          });
        },
      });
      completedBytes += Math.max(0, bytes - resumedFrom);
    }

    console.log(`✅ Slotstream checkpoint ready: ${repo} → ${plan.modelDir}`);
    onProgress({
      event: 'complete',
      model: repo,
      received: plan.totalBytes,
      total: plan.totalBytes,
      message: `${label} downloaded`,
    });
    return {
      success: true,
      model: slotstreamModelDirName(repo),
      repo,
      path: plan.modelDir,
      files: plan.files.length,
      sizeBytes: plan.totalBytes,
    };
  } catch (err) {
    const error = state.stalled ? stalledError() : err;
    console.error(`❌ Slotstream checkpoint download failed for ${repo}: ${error.message}`);
    onProgress({ event: 'error', model: repo, message: error.message });
    return { success: false, model: repo, error: error.message, code: error.code || null };
  } finally {
    inFlight.delete(modelDir);
  }
}

/**
 * The watchdog's abort reaches the catch as a generic AbortError, which says
 * nothing useful; this is what the user is told instead. There is deliberately
 * no user-facing cancel yet — the stall watchdog is the only thing that aborts
 * a transfer, so `state.stalled` is the only reason this fires.
 */
function stalledError() {
  const minutes = Math.round(IDLE_STALL_TIMEOUT_MS / 60000);
  return new ServerError(
    `Download stalled — no bytes received for ${minutes} minute${minutes === 1 ? '' : 's'}, so it was abandoned. Its progress is kept: pressing download again resumes from where it stopped.`,
    { status: 504, code: 'SLOTSTREAM_DOWNLOAD_STALLED' },
  );
}

/** True while a checkpoint download is writing under `path` (or its `.partial`). */
export function isSlotstreamDownloadInFlight(path) {
  if (!path || inFlight.size === 0) return false;
  const target = String(path);
  for (const modelDir of inFlight.keys()) {
    if (target === modelDir || target.startsWith(`${modelDir}/`)) return true;
  }
  return false;
}

/** Clears in-flight download bookkeeping (used by test suites). */
export function _resetSlotstreamDownloadsForTests() {
  inFlight.clear();
}

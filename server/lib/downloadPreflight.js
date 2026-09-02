/**
 * Free-disk preflight, hash verification, and resumable streaming for large
 * weight downloads.
 *
 * A multi-gigabyte GGUF/safetensors pull is a decision the user makes with
 * numbers in front of them: before transferring anything we report size,
 * destination, and free disk, and refuse outright when the volume cannot hold
 * it. An interrupted transfer keeps its `.partial` so a retry can Range-resume
 * rather than restart; a completed file is checked against a published hash
 * before it is allowed to become a selectable model.
 *
 * `statfs` is already used for health/resources — this is the same reading,
 * consulted before spending tens of gigabytes.
 */

import { createWriteStream } from 'fs';
import { rm, stat, statfs, rename } from 'fs/promises';
import { dirname } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { ServerError } from './errorHandler.js';
import { ensureDir, sha256File } from './fileCore.js';

/** Spare room kept on top of the advertised payload so a full disk isn't a photo-finish. */
export const DOWNLOAD_HEADROOM_BYTES = 512 * 1024 * 1024;

export const DOWNLOAD_VERDICTS = Object.freeze({
  OK: 'ok',
  TIGHT: 'tight',
  INSUFFICIENT: 'insufficient',
});

/** After the download, remaining free space below this share of current free is "tight". */
const TIGHT_REMAINING_RATIO = 0.1;

const PARTIAL_SUFFIX = '.partial';

export const partialPathFor = (destPath) => `${destPath}${PARTIAL_SUFFIX}`;

export function normalizeSha256(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, '').replace(/['"]/g, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** Size + digest a Hugging Face sibling object actually carries (often via LFS). */
export function siblingDownloadMeta(sibling) {
  if (!sibling || typeof sibling !== 'object') return { bytes: 0, sha256: null };
  const bytes = Number(sibling.lfs?.size ?? sibling.size) || 0;
  return { bytes, sha256: normalizeSha256(sibling.lfs?.sha256 || sibling.lfs?.oid) };
}

const parseContentRangeTotal = (header) => {
  const match = String(header || '').match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : 0;
};

async function freeBytesForPath(destPath, statfsImpl) {
  let probe = destPath || '/';
  for (let i = 0; i < 8; i += 1) {
    const stats = await statfsImpl(probe).catch(() => null);
    if (stats && Number.isFinite(stats.bavail) && Number.isFinite(stats.bsize)) {
      return stats.bavail * stats.bsize;
    }
    const parent = dirname(probe);
    if (!parent || parent === probe) break;
    probe = parent;
  }
  return null;
}

/**
 * Given a destination path and an expected byte total, report free bytes,
 * required bytes (payload + headroom), and a verdict.
 *
 * `freeBytes: null` means statfs was unavailable — the verdict is `ok` so a
 * failed reading cannot block a download that would have fit. `expectedBytes`
 * of 0 means the size is unknown: we never refuse (cannot know it will fail)
 * and never mark tight.
 * A leftover `${destPath}.partial` from a prior attempt already occupies its
 * share of disk — resuming only needs the REMAINING bytes, not the full
 * payload again. Refusing on the full size would make a nearly-full disk
 * reject a resume it can actually complete, defeating the resumable-download
 * path in exactly the low-space scenario it exists for.
 *
 * @param {{ destPath?: string, expectedBytes?: number, headroomBytes?: number, statfsImpl?: typeof statfs }} opts
 */
export async function assessDownloadPreflight({
  destPath,
  expectedBytes = 0,
  headroomBytes = DOWNLOAD_HEADROOM_BYTES,
  statfsImpl = statfs,
} = {}) {
  const expected = Math.max(0, Number(expectedBytes) || 0);
  const headroom = Math.max(0, Number(headroomBytes) || 0);
  const partialBytes = destPath
    ? await stat(partialPathFor(destPath)).then((s) => s.size, () => 0)
    : 0;
  const remaining = Math.max(0, expected - partialBytes);
  const requiredBytes = remaining > 0 ? remaining + headroom : 0;
  const freeBytes = await freeBytesForPath(destPath, statfsImpl);

  let verdict = DOWNLOAD_VERDICTS.OK;
  if (freeBytes != null && remaining > 0 && freeBytes < remaining) {
    verdict = DOWNLOAD_VERDICTS.INSUFFICIENT;
  } else if (
    freeBytes != null
    && remaining > 0
    && freeBytes - remaining < Math.max(headroom, freeBytes * TIGHT_REMAINING_RATIO)
  ) {
    verdict = DOWNLOAD_VERDICTS.TIGHT;
  }

  return {
    destPath: destPath || null,
    expectedBytes: expected,
    requiredBytes,
    headroomBytes: headroom,
    freeBytes,
    verdict,
  };
}

export function diskInsufficientError(assessment) {
  const free = assessment.freeBytes == null ? 'unknown' : `${assessment.freeBytes}`;
  return new ServerError(
    `Not enough free disk to download ${assessment.expectedBytes} bytes to ${assessment.destPath} (free: ${free}, need ${assessment.requiredBytes} including headroom)`,
    {
      status: 507,
      code: 'DISK_INSUFFICIENT',
      context: {
        destPath: assessment.destPath,
        expectedBytes: assessment.expectedBytes,
        requiredBytes: assessment.requiredBytes,
        headroomBytes: assessment.headroomBytes,
        freeBytes: assessment.freeBytes,
        verdict: assessment.verdict,
      },
    },
  );
}

/** Throw DISK_INSUFFICIENT when the verdict is insufficient; otherwise return the assessment. */
export function assertDownloadFits(assessment) {
  if (assessment?.verdict === DOWNLOAD_VERDICTS.INSUFFICIENT) {
    throw diskInsufficientError(assessment);
  }
  return assessment;
}

/**
 * HEAD (then a 0-byte Range GET) a URL for Content-Length / LFS sha.
 * Returns `{ bytes: 0, sha256: null }` when the server will not say — never throws
 * for a probe miss, so a CDN that refuses HEAD cannot block the download.
 */
export async function probeRemoteSize(url, { headers = {}, fetchImpl = fetch, signal } = {}) {
  const empty = { bytes: 0, sha256: null };
  const readMeta = (res) => {
    if (!res || typeof res.headers?.get !== 'function') return empty;
    const length = Number(res.headers.get('content-length')) || 0;
    const rangeTotal = parseContentRangeTotal(res.headers.get('content-range'));
    const sha256 = normalizeSha256(
      res.headers.get('x-linked-etag') || res.headers.get('etag') || '',
    );
    return { bytes: rangeTotal || length, sha256 };
  };

  const head = await fetchImpl(url, { method: 'HEAD', headers, redirect: 'follow', signal }).catch(() => null);
  if (head?.ok) {
    const meta = readMeta(head);
    if (meta.bytes > 0 || meta.sha256) return meta;
  }

  const ranged = await fetchImpl(url, {
    method: 'GET',
    headers: { ...headers, Range: 'bytes=0-0' },
    redirect: 'follow',
    signal,
  }).catch(() => null);
  if (ranged?.ok || ranged?.status === 206) {
    // Drain a 1-byte body so the socket can close; ignore failure.
    await ranged.body?.cancel?.().catch(() => {});
    return readMeta(ranged);
  }
  return empty;
}

export async function verifyDownloadHash(filePath, expectedSha256) {
  const want = normalizeSha256(expectedSha256);
  if (!want) return { ok: true, skipped: true };
  const actual = (await sha256File(filePath)).toLowerCase();
  if (actual !== want) return { ok: false, expected: want, actual };
  return { ok: true, expected: want, actual };
}

const hashMismatchError = (destPath, check) => new ServerError(
  `Download failed SHA-256 verification for ${destPath} (expected ${check.expected.slice(0, 12)}…, got ${check.actual.slice(0, 12)}…) — the file was deleted`,
  {
    status: 502,
    code: 'DOWNLOAD_HASH_MISMATCH',
    context: { destPath, expected: check.expected, actual: check.actual },
  },
);

/**
 * Stream `url` into `${destPath}.partial`, Range-resuming when a leftover
 * partial exists. Transport/stall failures keep the partial; a user cancel
 * discards it. Optionally verifies a published sha256 and renames into place.
 *
 * @returns {Promise<{ bytes: number, tmpPath: string, resumed: boolean }>}
 */
export async function streamResumableDownload({
  url,
  destPath,
  headers = {},
  fetchImpl = fetch,
  onBytes = () => {},
  signal,
  onIdleStall,
  idleStallTimeoutMs = 0,
  isCancelled = () => false,
  expectedSha256 = null,
  finalize = true,
  onHttpError = null,
} = {}) {
  const tmpPath = partialPathFor(destPath);
  await ensureDir(dirname(destPath));

  const existing = await stat(tmpPath).catch(() => null);
  let resumeFrom = existing?.isFile() ? existing.size : 0;

  const reqHeaders = { ...headers };
  if (resumeFrom > 0) reqHeaders.Range = `bytes=${resumeFrom}-`;

  let idleTimer = null;
  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
  const resetIdleTimer = () => {
    if (!idleStallTimeoutMs || !onIdleStall) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      try {
        onIdleStall();
      } catch (err) {
        console.error(`❌ Download stall watchdog failed: ${err.message}`);
      }
    }, idleStallTimeoutMs);
    idleTimer.unref?.();
  };

  resetIdleTimer();
  try {
    const res = await fetchImpl(url, { headers: reqHeaders, redirect: 'follow', signal });
    if (!res.ok && res.status !== 206) {
      if (res.status === 416 && resumeFrom > 0) {
        // Partial is past what the server has — start clean.
        await rm(tmpPath, { force: true }).catch(() => {});
        resumeFrom = 0;
        delete reqHeaders.Range;
        return streamResumableDownload({
          url, destPath, headers, fetchImpl, onBytes, signal, onIdleStall,
          idleStallTimeoutMs, isCancelled, expectedSha256, finalize, onHttpError,
        });
      }
      if (onHttpError) onHttpError(res);
      return rejectDownloadStatus(res);
    }
    if (!res.body) {
      throw new ServerError('Download returned no body', { status: 502, code: 'DOWNLOAD_FAILED' });
    }

    // Server ignored Range and sent the whole file — discard the leftover
    // prefix. The preflight the caller ran before starting only reserved the
    // REMAINING bytes (crediting the partial already on disk); now the FULL
    // payload is about to land instead, so recheck capacity against this
    // response's own Content-Length before writing over the freed space.
    if (resumeFrom > 0 && res.status === 200) {
      await rm(tmpPath, { force: true }).catch(() => {});
      resumeFrom = 0;
      const freshLength = Number(res.headers?.get?.('content-length')) || 0;
      if (freshLength > 0) {
        assertDownloadFits(await assessDownloadPreflight({ destPath, expectedBytes: freshLength }));
      }
    }

    const rangeTotal = parseContentRangeTotal(res.headers?.get?.('content-range'));
    const contentLength = Number(res.headers?.get?.('content-length')) || 0;
    const total = rangeTotal || (resumeFrom > 0 ? resumeFrom + contentLength : contentLength);
    let received = resumeFrom;
    const flags = resumeFrom > 0 ? 'a' : 'w';

    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        resetIdleTimer();
        onBytes(received, total);
        cb(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmpPath, { flags })).catch(async (err) => {
      if (isCancelled()) await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    });

    const check = await verifyDownloadHash(tmpPath, expectedSha256);
    if (!check.ok) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw hashMismatchError(destPath, check);
    }

    if (finalize) await rename(tmpPath, destPath);
    return { bytes: received || total, tmpPath, resumed: resumeFrom > 0 };
  } finally {
    clearIdleTimer();
  }
}

function rejectDownloadStatus(res) {
  if (res.status === 401 || res.status === 403) {
    throw new ServerError(
      `Download rejected (${res.status})`,
      { status: res.status, code: 'DOWNLOAD_AUTH' },
    );
  }
  throw new ServerError(
    `Download failed: ${res.status} ${res.statusText || ''}`.trim(),
    { status: 502, code: 'DOWNLOAD_FAILED' },
  );
}

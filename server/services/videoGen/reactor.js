/**
 * Video Gen — Reactor.inc `fast-h3` video generation API provider (#6214).
 *
 * A cloud-only, near-realtime (~1.0x) video backend with native
 * clip-to-clip chaining (`continue_from_clip_id`), unlike the local
 * runtimes or the fal.ai/grok queue backends. Mirrors `videoGen/fal.js`'s
 * job-map/SSE contract (cloud lane, no local child process) so
 * `mediaJobQueue` can dispatch to it the same way.
 *
 * Auth flow: PortOS never hands the caller the raw `REACTOR_API_KEY` — it
 * mints a short-lived, scoped session JWT server-side (`mintReactorToken`,
 * also exposed at `GET /api/video-gen/reactor/token`) and uses that JWT to
 * submit/poll/cancel. Flow: POST the prompt (plus optional
 * `continue_from_clip_id` and a base64-encoded starting frame) to
 * `api.reactor.inc/v1/fast-h3/generate`, poll the returned status URL until
 * COMPLETED, then download the resulting MP4 and hand it to the shared
 * `finalizeGeneratedVideo` helper — same streaming optimization, thumbnail,
 * and history entry as every other video backend.
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { finalizeGeneratedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { getSettings } from '../settings.js';

export const REACTOR_API_BASE = 'https://api.reactor.inc';
export const REACTOR_MODEL_ID = 'fast-h3';
export const REACTOR_MAX_PROMPT_LENGTH = 800;

const REACTOR_TOKEN_TIMEOUT_MS = 15_000;
const REACTOR_SUBMIT_TIMEOUT_MS = 30_000;
const REACTOR_POLL_TIMEOUT_MS = 15_000;
const REACTOR_POLL_INTERVAL_MS = 3000;
const REACTOR_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
// A cloud render can queue behind other tenants before it starts — generously
// bounded, same order of magnitude as fal's and grok's render caps.
const REACTOR_RENDER_TIMEOUT_MS = (() => {
  const n = Number(process.env.REACTOR_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();

// Per-job state — keyed by jobId (cloud lane allows parallel renders). Same
// client shape as videoGen/fal.js so attachSseClient/broadcastSse work.
const jobs = new Map();
// Tracks the reactor.inc request so cancel() can both stop our poll loop and
// ask reactor.inc to cancel the queued/running render.
const activeRequests = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

/**
 * Resolve the reactor.inc API key: settings override, else the
 * `REACTOR_API_KEY` env var (same settings-wins-over-env precedence as
 * `videoGen/fal.js`'s `resolveFalApiKey`).
 */
export function resolveReactorApiKey(settings) {
  const fromSettings = (settings?.videoGen?.reactor?.apiKey || '').trim();
  if (fromSettings) return fromSettings;
  const fromEnv = (process.env.REACTOR_API_KEY || '').trim();
  return fromEnv || null;
}

/**
 * Mint a short-lived session JWT scoped to `reactor/fast-h3`, bounded to one
 * concurrent session. Called by the `/api/video-gen/reactor/token` route AND
 * internally before every submit — the raw API key never leaves this module.
 */
export async function mintReactorToken(apiKey) {
  if (!apiKey) {
    throw new ServerError('No reactor.inc API key configured — set it in Settings > Video Gen or the REACTOR_API_KEY env var', { status: 400, code: 'REACTOR_NOT_CONFIGURED' });
  }
  const res = await fetchWithTimeout(`${REACTOR_API_BASE}/tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authorization_details: [{ type: `reactor/${REACTOR_MODEL_ID}`, max_sessions: 1 }],
    }),
  }, REACTOR_TOKEN_TIMEOUT_MS);
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.jwt) {
    const reason = payload?.detail ? JSON.stringify(payload.detail) : `HTTP ${res.status}`;
    throw new ServerError(`reactor.inc token minting failed: ${reason}`, { status: 502, code: 'REACTOR_TOKEN_FAILED' });
  }
  return { jwt: payload.jwt, expiresAt: payload.expires_at || null };
}

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("videoGen/reactor.cancel requires a jobId — use cancelAll() to terminate every in-flight render");
  }
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  if (entry.cancelUrl && entry.jwt) {
    fetchWithTimeout(entry.cancelUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${entry.jwt}` },
    }, REACTOR_POLL_TIMEOUT_MS).catch(() => {});
  }
  return true;
};

export const cancelAll = () => {
  const ids = [...activeRequests.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

async function toDataUri(imagePath) {
  const buf = await readFile(imagePath);
  const detected = detectImageFormat(buf);
  const mime = detected?.mime || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function buildRequestBody({ prompt, continueFromClipId, startingFrameDataUri, seconds, seed }) {
  const body = { prompt: prompt.trim().slice(0, REACTOR_MAX_PROMPT_LENGTH) };
  if (continueFromClipId) body.continue_from_clip_id = continueFromClipId;
  if (startingFrameDataUri) body.starting_frame = startingFrameDataUri;
  if (seconds) body.seconds = Number(seconds);
  if (seed !== undefined && seed !== null && seed !== '') body.seed = Number(seed);
  return body;
}

async function submitReactorJob({ jwt, body }) {
  const res = await fetchWithTimeout(`${REACTOR_API_BASE}/v1/${REACTOR_MODEL_ID}/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, REACTOR_SUBMIT_TIMEOUT_MS);
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.clip_id) {
    const reason = payload?.detail ? JSON.stringify(payload.detail) : `HTTP ${res.status}`;
    throw new ServerError(`reactor.inc rejected the request: ${reason}`, { status: 502, code: 'REACTOR_SUBMIT_FAILED' });
  }
  return payload;
}

async function pollReactorStatus({ statusUrl, jwt }) {
  const res = await fetchWithTimeout(statusUrl, {
    headers: { Authorization: `Bearer ${jwt}` },
  }, REACTOR_POLL_TIMEOUT_MS);
  if (res.status === 401) {
    throw new ServerError('reactor.inc session expired', { status: 401, code: 'REACTOR_TOKEN_EXPIRED' });
  }
  if (!res.ok) throw new ServerError(`reactor.inc status check failed: HTTP ${res.status}`, { status: 502, code: 'REACTOR_STATUS_FAILED' });
  return res.json();
}

export async function generateVideo({
  settings, prompt = '', negativePrompt,
  continueFromClipId, seconds, seed,
  sourceImagePath = null, jobId: providedJobId = null,
}) {
  await ensureDir(PATHS.videos);
  const renderStartedAtMs = Date.now();

  if (!prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // The reactor API key stays server-side: re-resolve live settings here
  // (mirrors videoGen/fal.js's precedent) rather than threading the secret
  // through job.params, where it would sit in plaintext in media-jobs.json.
  const effectiveSettings = settings || await getSettings().catch(() => null);
  const apiKey = resolveReactorApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError('No reactor.inc API key configured — set it in Settings > Video Gen or the REACTOR_API_KEY env var', { status: 400, code: 'REACTOR_NOT_CONFIGURED' });
  }

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);

  const meta = {
    id: jobId,
    prompt: prompt.trim(),
    negativePrompt: negativePrompt || '',
    modelId: `reactor:${REACTOR_MODEL_ID}`,
    ...(continueFromClipId ? { continueFromClipId } : {}),
    ...(seconds ? { seconds } : {}),
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] reactor (${REACTOR_MODEL_ID}): ${prompt.slice(0, 60)}…`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  broadcastSse(job, { type: 'status', message: 'Minting reactor.inc session…' });

  runReactorVideo(job, jobId, {
    apiKey, prompt, continueFromClipId, seconds, seed, sourceImagePath, outputPath, filename, meta,
  }).catch((err) => {
    console.log(`❌ reactor video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/videos/${filename}`, generationId: jobId,
    mode: 'reactor',
    status: 'running',
  };
}

async function runReactorVideo(job, jobId, {
  apiKey, prompt, continueFromClipId, seconds, seed, sourceImagePath, outputPath, filename, meta,
}) {
  const entry = { jwt: null, aborted: false, cancelUrl: null };
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + REACTOR_RENDER_TIMEOUT_MS;
  try {
    let { jwt } = await mintReactorToken(apiKey);
    entry.jwt = jwt;
    if (entry.aborted) return finalizeCanceled(job, jobId);

    const startingFrameDataUri = sourceImagePath ? await toDataUri(sourceImagePath) : null;
    const body = buildRequestBody({
      prompt, continueFromClipId, startingFrameDataUri, seconds, seed,
    });
    broadcastSse(job, { type: 'status', message: 'Submitting to reactor.inc…' });
    const submitted = await submitReactorJob({ jwt, body });
    entry.cancelUrl = submitted.cancel_url || `${REACTOR_API_BASE}/v1/${REACTOR_MODEL_ID}/clips/${submitted.clip_id}/cancel`;
    const statusUrl = submitted.status_url || `${REACTOR_API_BASE}/v1/${REACTOR_MODEL_ID}/clips/${submitted.clip_id}`;

    while (Date.now() < deadline) {
      if (entry.aborted) return finalizeCanceled(job, jobId);
      videoGenEvents.emit('activity', { generationId: jobId });
      // A 20-minute render can outlive a short-lived session JWT — re-mint
      // once and retry rather than failing a render that's still in flight.
      let status;
      try {
        status = await pollReactorStatus({ statusUrl, jwt });
      } catch (err) {
        if (err?.code !== 'REACTOR_TOKEN_EXPIRED') throw err;
        ({ jwt } = await mintReactorToken(apiKey));
        entry.jwt = jwt;
        status = await pollReactorStatus({ statusUrl, jwt });
      }
      if (status.status === 'completed') {
        const videoUrl = status.video_url || status.output?.video_url;
        if (!videoUrl) {
          return finalizeError(job, jobId, 'reactor.inc completed but returned no video URL');
        }
        broadcastSse(job, { type: 'status', message: 'Downloading video…' });
        const videoRes = await fetchWithTimeout(videoUrl, {}, REACTOR_DOWNLOAD_TIMEOUT_MS);
        if (!videoRes.ok) {
          return finalizeError(job, jobId, `reactor.inc video download failed: HTTP ${videoRes.status}`);
        }
        const buffer = Buffer.from(await videoRes.arrayBuffer());
        await writeFile(outputPath, buffer);

        activeRequests.delete(jobId);
        activeJobs.delete(jobId);
        await finalizeGeneratedVideo({
          job,
          jobId,
          outputPath,
          filename,
          meta: { ...meta, clipId: status.clip_id || null },
          actualSeed: seed ?? null,
          mutateHistory: mutateVideoHistory,
        });
        closeJobAfterDelay(jobs, jobId);
        return;
      }
      if (status.status === 'failed') {
        return finalizeError(job, jobId, `reactor.inc render failed: ${status.error || 'unknown error'}`);
      }
      broadcastSse(job, { type: 'status', message: status.status === 'processing' ? 'Rendering…' : 'Queued…' });
      await new Promise((r) => setTimeout(r, REACTOR_POLL_INTERVAL_MS));
    }
    if (entry.aborted) return finalizeCanceled(job, jobId);
    return finalizeError(job, jobId, `reactor.inc did not finish within ${Math.round(REACTOR_RENDER_TIMEOUT_MS / 1000)}s`);
  } catch (err) {
    finalizeError(job, jobId, `reactor.inc video generation failed: ${err?.message || err}`);
  }
}

const finalizeCanceled = (job, jobId) => finalizeError(job, jobId, 'Canceled', { force: true });

const finalizeError = (job, jobId, reason, { force = false } = {}) => {
  if (!force && (job.status === 'error' || job.status === 'complete')) return;
  activeRequests.delete(jobId);
  activeJobs.delete(jobId);
  job.status = 'error';
  console.log(`❌ reactor video generation failed [${jobId.slice(0, 8)}]: ${reason.split('\n')[0]}`);
  broadcastSse(job, { type: 'error', error: reason });
  videoGenEvents.emit('failed', { generationId: jobId, error: reason });
  closeJobAfterDelay(jobs, jobId);
};

// Test-only handles.
export const _internals = {
  buildRequestBody,
  toDataUri,
};

/**
 * Speculative-decoding weights: on-disk state + one-click Hugging Face download.
 *
 * The llama-server launcher names GGUF files it cannot produce — the weights are
 * a separate multi-gigabyte download — so before this module the only way to
 * learn a preset's file was missing was to press Start and read the 400. This
 * reports per-preset "downloaded / not downloaded" from disk and fetches the
 * missing file straight into the path the launcher will hand llama.cpp.
 *
 * Path resolution is shared with llamaServerManager (`resolveSpecModelPath`) so
 * the download target and the launcher's existence check can never disagree
 * about which file a relative or `~`-prefixed path means.
 */

import { createWriteStream } from 'fs';
import { rename, rm, stat } from 'fs/promises';
import { dirname, resolve } from 'path';
import { randomBytes } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { ensureDir, expandHome } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { buildHfAuthHeaders, buildHfResolveUrl, fetchHuggingfaceModel, modelSiblingFilenames } from '../lib/huggingfaceLora.js';
import { getHfToken } from '../lib/hfToken.js';
import {
  SPEC_DECODE_PRESETS,
  SPEC_MODEL_ROLES,
  findSpecDecodePreset,
  hfSearchUrl,
  specDecodeSource,
} from '../lib/specDecodePresets.js';

// Progress frames are throttled to this interval so a fast link can't flood the
// socket with a frame per chunk.
const PROGRESS_INTERVAL_MS = 250;

// Downloads in flight, keyed by RESOLVED destination path (two presets can name
// the same base model, and both must show the one transfer rather than starting
// a second copy of it).
const inFlight = new Map();

/**
 * Absolute path a launcher field refers to. Relative paths resolve against the
 * server's cwd — the cwd llama-server inherits — and `~` is expanded here
 * because `spawn` performs no shell expansion.
 */
export const resolveSpecModelPath = (path) => resolve(expandHome(String(path || '').trim()));

const fileStat = async (path) => {
  const stats = await stat(resolveSpecModelPath(path)).catch(() => null);
  return stats?.isFile() ? stats : null;
};

/** State of one preset role (base or drafter) for the UI. */
const describeEntry = async (presetId, role) => {
  const entry = findSpecDecodePreset(presetId)?.[role];
  if (!entry?.path) return null;
  const destPath = resolveSpecModelPath(entry.path);
  const stats = await stat(destPath).catch(() => null);
  const active = inFlight.get(destPath);
  return {
    role,
    path: entry.path,
    exists: Boolean(stats?.isFile()),
    sizeBytes: stats?.isFile() ? stats.size : null,
    repo: entry.repo || null,
    repoUrl: entry.repo ? `https://huggingface.co/${entry.repo}` : hfSearchUrl(entry.path),
    downloadable: Boolean(entry.repo),
    downloading: Boolean(active),
    received: active?.received ?? null,
    total: active?.total ?? null,
  };
};

/**
 * Every preset with its weights' on-disk state. Disk + in-memory only — listing
 * the launcher must never reach out to Hugging Face (or any provider) on its own.
 */
export async function getSpecDecodePresetStatus() {
  return Promise.all(SPEC_DECODE_PRESETS.map(async (preset) => ({
    id: preset.id,
    label: preset.label,
    specType: preset.specType,
    model: await describeEntry(preset.id, 'model'),
    draftModel: await describeEntry(preset.id, 'draftModel'),
  })));
}

// A quant hint matches loosely: repos publish `…-Q4_K_M.gguf`, `….q4_k_m.gguf`
// and `…-Q4_K_M-00001-of-00002.gguf` for the same build.
const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
const isShard = (filename) => /-\d{5}-of-\d{5}\.gguf$/i.test(filename);

/**
 * Choose which `.gguf` sibling of the repo to fetch.
 *
 * Sharded (multi-part) builds are refused rather than half-downloaded: llama.cpp
 * wants every part, and a lone `-00001-of-00003.gguf` on disk would satisfy the
 * launcher's existence check and then fail at load time — the exact confusion
 * this whole module exists to remove.
 */
export function pickGgufSibling(model, { file, quant, repo }) {
  const ggufs = modelSiblingFilenames(model).filter((name) => /\.gguf$/i.test(name));
  if (!ggufs.length) {
    throw new ServerError(`Hugging Face repo ${repo} publishes no .gguf file`, { status: 422, code: 'SPEC_NO_GGUF' });
  }
  if (file) {
    const exact = ggufs.find((name) => name === file);
    if (exact) return exact;
  }
  const whole = ggufs.filter((name) => !isShard(name));
  const wanted = quant ? normalize(quant) : null;
  const matches = wanted ? whole.filter((name) => normalize(name).includes(wanted)) : whole;
  if (matches.length) {
    // Shortest name wins among equals: `Qwen3.8-27B-Q4_K_M.gguf` over a
    // `…-Q4_K_M-abliterated.gguf` variant that also carries the quant.
    return [...matches].sort((a, b) => a.length - b.length)[0];
  }
  if (whole.length) {
    throw new ServerError(
      `Hugging Face repo ${repo} has no ${quant} build — available: ${whole.slice(0, 6).join(', ')}`,
      { status: 422, code: 'SPEC_QUANT_MISSING' },
    );
  }
  throw new ServerError(
    `Hugging Face repo ${repo} publishes only sharded (multi-part) GGUFs, which PortOS can't assemble. Download it manually from https://huggingface.co/${repo}.`,
    { status: 422, code: 'SPEC_SHARDED_GGUF' },
  );
}

const streamToFile = async ({ url, headers, destPath, onBytes }) => {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) {
    if (res.status === 401 || res.status === 403) {
      throw new ServerError(
        `Hugging Face rejected the download (${res.status}) — this repo is gated. Accept its license on Hugging Face and add your HF token in Image Gen settings, then retry.`,
        { status: res.status, code: 'HF_AUTH' },
      );
    }
    throw new ServerError(`Hugging Face download failed: ${res.status} ${res.statusText}`, { status: 502, code: 'HF_DOWNLOAD_FAILED' });
  }
  const total = Number(res.headers?.get?.('content-length')) || 0;
  // A random temp suffix keeps a crashed transfer's leftovers from being
  // mistaken for this one's, and keeps the half-written file out of the
  // launcher's existence check until it is complete.
  const tmpPath = `${destPath}.${randomBytes(6).toString('hex')}.partial`;
  await ensureDir(dirname(destPath));
  let received = 0;
  // Count bytes in a passthrough Transform, NOT a bare `.on('data')` listener —
  // that flips the source into flowing mode and defeats pipeline backpressure.
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      onBytes(received, total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(tmpPath)).catch(async (err) => {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  });
  await rename(tmpPath, destPath);
  return { bytes: received || total };
};

/**
 * Download one preset role's GGUF into the path the launcher expects.
 *
 * @param {{ presetId: string, role: string, onProgress?: (frame: object) => void }} params
 */
export async function downloadSpecDecodeModel({ presetId, role, onProgress = () => {} }) {
  if (!SPEC_MODEL_ROLES.includes(role)) {
    throw new ServerError(`Unknown model role "${role}"`, { status: 400 });
  }
  const source = specDecodeSource(presetId, role);
  if (!source) {
    throw new ServerError(
      `No Hugging Face source is registered for that preset's ${role === 'model' ? 'base model' : 'drafter'} — download it manually and point the field at the file.`,
      { status: 400, code: 'SPEC_NO_SOURCE' },
    );
  }

  const destPath = resolveSpecModelPath(source.path);
  const existing = await fileStat(source.path);
  if (existing) {
    return { success: true, alreadyDownloaded: true, path: source.path, sizeBytes: existing.size };
  }
  if (inFlight.has(destPath)) {
    throw new ServerError(`${source.path} is already downloading`, { status: 409, code: 'SPEC_DOWNLOAD_IN_FLIGHT' });
  }

  const token = await getHfToken();
  const headers = buildHfAuthHeaders(token);
  onProgress({ event: 'start', presetId, role, path: source.path, message: `Resolving ${source.repo} on Hugging Face…` });
  const model = await fetchHuggingfaceModel(source.repo, { token });
  const file = pickGgufSibling(model, { file: source.file, quant: source.quant, repo: source.repo });

  const state = { presetId, role, received: 0, total: 0 };
  inFlight.set(destPath, state);
  let lastEmit = 0;
  console.log(`⬇️  Downloading speculative-decoding weights ${source.repo}/${file} → ${source.path}`);
  try {
    const { bytes } = await streamToFile({
      url: buildHfResolveUrl(source.repo, 'main', file),
      headers,
      destPath,
      onBytes: (received, total) => {
        state.received = received;
        state.total = total;
        const now = Date.now();
        if (now - lastEmit < PROGRESS_INTERVAL_MS) return;
        lastEmit = now;
        onProgress({ event: 'progress', presetId, role, path: source.path, received, total });
      },
    });
    onProgress({ event: 'complete', presetId, role, path: source.path, received: bytes, total: bytes, message: `${source.path} downloaded` });
    console.log(`✅ Speculative-decoding weights ready: ${source.path} (${bytes} bytes)`);
    return { success: true, path: source.path, repo: source.repo, file, sizeBytes: bytes };
  } catch (err) {
    onProgress({ event: 'error', presetId, role, path: source.path, message: err.message });
    console.error(`❌ Speculative-decoding download failed for ${source.path}: ${err.message}`);
    throw err;
  } finally {
    inFlight.delete(destPath);
  }
}

/** Clears in-flight download bookkeeping (used by test suites). */
export function _resetSpecDecodeDownloadsForTests() {
  inFlight.clear();
}

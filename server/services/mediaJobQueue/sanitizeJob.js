import { renderFederatedMediaAudioPrompt } from '../../lib/federatedMediaWire.js';

// Public projection of a media job. Keep worker-only paths and subprocess
// details out of both the queue API and the processing dashboard.
const PARAM_ALLOWLIST = new Set([
  'prompt', 'negativePrompt', 'modelId', 'model', 'effort',
  'width', 'height', 'numFrames', 'fps', 'steps', 'guidanceScale',
  'seed', 'tiling', 'disableAudio', 'mode', 'imageStrength',
  'textEncoderId', 'chunks', 'chunkPrompts', 'contextFrames', 'loras',
  'cfgScale', 'guidance', 'quantize',
  'runId', 'runtime', 'datasetId', 'characterId', 'characterName',
  'triggerWord', 'rank', 'baseModelId', 'spriteRef', 'spriteWalk',
]);

const MUSIC_STUDIO_KEYS = new Set([
  'trackId', 'title', 'artistId', 'artist', 'albumId', 'lyricsEnabled', 'lyricsProvided', 'instrumentalOnly',
]);

export function sanitizeJob(job) {
  if (!job) return job;
  const safeParams = job.params
    ? Object.fromEntries(Object.entries(job.params)
      .filter(([key]) => PARAM_ALLOWLIST.has(key) || key === 'musicStudio')
      .map(([key, value]) => [
        key,
        key === 'musicStudio' && value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).filter(([nestedKey]) => MUSIC_STUDIO_KEYS.has(nestedKey)))
          : value,
      ]))
    : undefined;
  // A remote job's conditioning text lives inside its versioned marker, never
  // in top-level params — that is what makes an older build (which cannot route
  // the marker) fail closed instead of quietly re-rendering the job locally.
  // Rebuild the prompt for the public projection without exposing private peer
  // routing state. Audio renders it from the fixed-vocabulary profile (free-form
  // personal text never reaches an audio provider at all); image and video carry
  // the submitted prompt itself.
  const remotePrompt = renderFederatedMediaAudioPrompt(job.params?.remoteMedia?.profile)
    ?? (typeof job.params?.remoteMedia?.request?.prompt === 'string'
      ? job.params.remoteMedia.request.prompt : null);
  if (safeParams && remotePrompt) {
    safeParams.prompt = remotePrompt;
  }
  return {
    id: job.id,
    kind: job.kind,
    owner: job.owner,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    position: job.position,
    progress: job.progress,
    statusMsg: job.statusMsg,
    etaMs: job.etaMs,
    error: job.error,
    result: job.result,
    params: safeParams,
  };
}

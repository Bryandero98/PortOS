/** Local video cohort circuit breaker; diagnostics never enter peer payloads. */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { CLOUD_VIDEO_GEN_MODES } from '../../lib/generationModes.js';
import { normalizeVideoFailure } from '../../lib/videoFailure.js';
import { isRemoteMediaJob } from './remoteMediaJob.js';

const cohortKey = ({ modelId, runtime }) => JSON.stringify([modelId, runtime]);
const isLocalVideo = (job) => job.kind === 'video'
  && !isRemoteMediaJob(job) && !CLOUD_VIDEO_GEN_MODES.includes(job.params?.mode);

export const videoHoldSchema = z.object({
  id: z.string().uuid(),
  modelId: z.string().min(1).max(256),
  runtime: z.string().min(1).max(128),
  classification: z.string().min(1).max(128),
  cause: z.string().min(1).max(240),
  heldAt: z.string().datetime(),
});

export function createVideoHolds() {
  const holds = new Map();
  const streaks = new Map();
  return {
    restore(value = []) {
      const result = z.array(videoHoldSchema).safeParse(value);
      if (!result.success) return false;
      for (const hold of result.data) holds.set(cohortKey(hold), hold);
      return true;
    },
    snapshot: () => [...holds.values()],
    has: (cohort) => holds.has(cohortKey(cohort)),
    clear() { holds.clear(); streaks.clear(); },
    async resolveCohorts(jobs) {
      const local = jobs.filter(isLocalVideo);
      if (!local.length) return;
      // Catalog loading stays off the queue's widely imported static graph.
      const { getVideoModels } = await import('../../lib/mediaModels.js');
      const omitted = (job) => job.params?.modelId === undefined || job.params?.modelId === '';
      let defaultModel = null;
      if (local.some(omitted)) {
        const { resolveVideoModelSelection } = await import('../videoGen/modelSelection.js');
        ({ model: defaultModel } = await resolveVideoModelSelection());
      }
      const models = getVideoModels();
      for (const job of local) {
        const model = omitted(job) ? defaultModel : models.find((m) => m.id === job.params.modelId);
        job.videoCohort = model ? { modelId: model.id, runtime: model.runtime || 'mlx_video' } : null;
      }
    },
    updateQueued(jobs) {
      const counts = new Map();
      for (const job of jobs) {
        const key = job.videoCohort && cohortKey(job.videoCohort);
        if (isLocalVideo(job) && holds.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
      }
      for (const job of jobs) {
        const key = job.videoCohort && cohortKey(job.videoCohort);
        job.hold = isLocalVideo(job) && holds.has(key)
          ? { ...holds.get(key), heldJobCount: counts.get(key) } : undefined;
      }
    },
    captureFailure(job, error, { code, failure } = {}) {
      if (!isLocalVideo(job)) return;
      job.videoFailure = failure !== undefined ? failure : normalizeVideoFailure(error, {
        code, prompts: [job.params?.prompt, job.params?.negativePrompt, ...(job.params?.chunkPrompts || [])],
      });
    },
    recordTerminal(job) {
      if (!isLocalVideo(job) || !job.videoCohort || job.status === 'canceled') return;
      const key = cohortKey(job.videoCohort);
      if (job.status === 'completed') { streaks.delete(key); return; }
      if (job.status !== 'failed') return;
      const failure = job.videoFailure;
      if (!failure) { streaks.delete(key); return; }
      const signature = failure.signature;
      const previous = streaks.get(key);
      const count = previous?.signature === signature ? previous.count + 1 : 1;
      streaks.set(key, { signature, count });
      if (count >= 3 && !holds.has(key)) {
        holds.set(key, { id: randomUUID(), ...job.videoCohort, classification: failure.classification, cause: failure.cause, heldAt: new Date().toISOString() });
      }
    },
    resume(id) {
      const entry = [...holds].find(([, hold]) => hold.id === id);
      if (!entry) return false;
      holds.delete(entry[0]);
      streaks.delete(entry[0]);
      return true;
    },
  };
}

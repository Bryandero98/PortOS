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
      for (const hold of z.array(videoHoldSchema).parse(value)) holds.set(cohortKey(hold), hold);
    },
    snapshot: () => [...holds.values()],
    clear() { holds.clear(); streaks.clear(); },
    async resolveCohorts(jobs) {
      const local = jobs.filter(isLocalVideo);
      if (!local.length) return;
      // Catalog loading stays off the queue's widely imported static graph.
      const { getVideoModels, getDefaultVideoModelId } = await import('../../lib/mediaModels.js');
      const models = getVideoModels();
      for (const job of local) {
        const modelId = job.params?.modelId || getDefaultVideoModelId();
        const model = models.find((m) => m.id === modelId);
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
    recordTerminal(job) {
      if (!isLocalVideo(job) || !job.videoCohort || job.status === 'canceled') return;
      const key = cohortKey(job.videoCohort);
      if (job.status === 'completed') { streaks.delete(key); return; }
      if (job.status !== 'failed') return;
      const failure = normalizeVideoFailure(job.error, {
        prompts: [job.params?.prompt, job.params?.negativePrompt, ...(job.params?.chunkPrompts || [])],
      });
      if (!failure) { streaks.delete(key); return; }
      const signature = JSON.stringify([failure.classification, failure.cause.toLowerCase()]);
      const previous = streaks.get(key);
      const count = previous?.signature === signature ? previous.count + 1 : 1;
      streaks.set(key, { signature, count });
      if (count >= 3 && !holds.has(key)) {
        holds.set(key, { id: randomUUID(), ...job.videoCohort, ...failure, heldAt: new Date().toISOString() });
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

import { mediaJobEvents } from '../mediaJobQueue/index.js';
import { queueCreativeDirectorRenderFailureTask } from './renderFailureTask.js';

let initialized = false;

function creativeDirectorTarget(job) {
  const sceneTag = job?.params?.creativeDirector;
  if (sceneTag?.projectId) return sceneTag;
  const musicTag = job?.params?.creativeDirectorMusicBed;
  if (musicTag?.projectId) return musicTag;
  return null;
}

async function onFailed(job) {
  const target = creativeDirectorTarget(job);
  if (!target) return;
  await queueCreativeDirectorRenderFailureTask({
    projectId: target.projectId,
    sceneId: target.sceneId || null,
    jobId: job.id,
    error: job.error || 'render failed',
  }).catch((error) => console.log(`⚠️ CD render repair task enqueue failed for ${job.id}: ${error.message}`));
}

export function initCreativeDirectorRenderFailureHook() {
  if (initialized) return;
  initialized = true;
  mediaJobEvents.on('failed', onFailed);
  console.log('🛠️ Creative Director render-failure recovery hook initialized');
}

export const __testing = {
  creativeDirectorTarget,
  reset() {
    if (initialized) mediaJobEvents.off('failed', onFailed);
    initialized = false;
  },
};

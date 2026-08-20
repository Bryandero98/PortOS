import { getCudaCapability, getCudaUtilization } from '../lib/cudaCapability.js';
import { listJobs, getRunningJob } from './mediaJobQueue/index.js';
import { sanitizeJob } from './mediaJobQueue/sanitizeJob.js';
import { listModels } from './imageTo3d/models.js';
import { getLoadedModels } from './ollamaManager.js';
import * as cos from './cos.js';

const LIVE_STATUSES = new Set(['queued', 'running']);

export async function getActiveProcessing() {
  const [capability, jobs, models, loadedModels, taskData, agents] = await Promise.all([
    getCudaCapability(),
    Promise.resolve(listJobs()).then((items) => items.filter((job) => LIVE_STATUSES.has(job.status))),
    listModels().catch(() => []),
    getLoadedModels().catch(() => []),
    cos.getAllTasks().catch(() => ({ user: {}, cos: {} })),
    cos.getAgents().catch(() => []),
  ]);
  const utilization = capability.status === 'available' ? await getCudaUtilization() : { status: capability.status, gpus: [] };
  // Both agent counts come off ONE read of the agent list. `cos.getStatus()`
  // reports the same running tally, but taking `active` from there and `queued`
  // from here would reintroduce the very skew this guards against.
  //
  // A task stays 'pending' until spawnAgentForTask flips it to 'in_progress',
  // which happens AFTER its agent is registered as running — so a snapshot taken
  // in between would count one task as queued AND active, and the widget read
  // 'N active, N queued' for a queue of N. A task a live agent holds is active.
  const runningAgents = agents.filter((agent) => agent.status === 'running');
  const claimedTaskIds = new Set(runningAgents.map((agent) => agent.taskId).filter(Boolean));
  const pendingTasks = [...(taskData.user?.tasks || []), ...(taskData.cos?.tasks || [])]
    .filter((task) => task.status === 'pending' && !claimedTaskIds.has(task.id)).length;
  const gpuBusy = Boolean(getRunningJob());
  return {
    updatedAt: new Date().toISOString(),
    gpu: {
      status: capability.status,
      laneBusy: gpuBusy,
      laneKind: getRunningJob()?.kind || null,
      gpus: (utilization.gpus.length ? utilization.gpus : capability.gpus).map((gpu) => ({
        name: gpu.name,
        utilizationPercent: gpu.utilizationPercent ?? null,
        memoryUsedMib: gpu.memoryUsedMib ?? null,
        memoryTotalMib: gpu.memoryTotalMib ?? gpu.vramMib ?? null,
      })),
    },
    jobs: jobs.map(sanitizeJob),
    extras: {
      imageTo3d: models.filter((model) => model.status === 'generating').map((model) => ({ id: model.id, name: model.name || model.id })),
      ollama: loadedModels,
    },
    agents: {
      active: runningAgents.length,
      queued: pendingTasks,
    },
  };
}

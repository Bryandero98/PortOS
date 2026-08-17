import { getCudaCapability, getCudaUtilization } from '../lib/cudaCapability.js';
import { listJobs, getRunningJob } from './mediaJobQueue/index.js';
import { sanitizeJob } from './mediaJobQueue/sanitizeJob.js';
import { listModels } from './imageTo3d/models.js';
import { getLoadedModels } from './ollamaManager.js';
import * as cos from './cos.js';

const LIVE_STATUSES = new Set(['queued', 'running']);

export async function getActiveProcessing() {
  const [capability, jobs, models, loadedModels, cosStatus, taskData] = await Promise.all([
    getCudaCapability(),
    Promise.resolve(listJobs()).then((items) => items.filter((job) => LIVE_STATUSES.has(job.status))),
    listModels().catch(() => []),
    getLoadedModels().catch(() => []),
    cos.getStatus().catch(() => null),
    cos.getAllTasks().catch(() => ({ user: {}, cos: {} })),
  ]);
  const utilization = capability.status === 'available' ? await getCudaUtilization() : { status: capability.status, gpus: [] };
  const pendingTasks = [...(taskData.user?.tasks || []), ...(taskData.cos?.tasks || [])]
    .filter((task) => task.status === 'pending').length;
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
      active: cosStatus?.activeAgents || 0,
      queued: pendingTasks,
    },
  };
}

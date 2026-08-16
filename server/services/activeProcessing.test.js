import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  capability: vi.fn(), utilization: vi.fn(), jobs: vi.fn(), running: vi.fn(), models: vi.fn(), loaded: vi.fn(), status: vi.fn(), tasks: vi.fn(),
}));
vi.mock('../lib/cudaCapability.js', () => ({ getCudaCapability: deps.capability, getCudaUtilization: deps.utilization }));
vi.mock('./mediaJobQueue/index.js', () => ({ listJobs: deps.jobs, getRunningJob: deps.running }));
vi.mock('./mediaJobQueue/sanitizeJob.js', () => ({ sanitizeJob: (job) => ({ id: job.id, kind: job.kind, status: job.status, params: { musicStudio: job.params.musicStudio } }) }));
vi.mock('./imageTo3d/models.js', () => ({ listModels: deps.models }));
vi.mock('./ollamaManager.js', () => ({ getLoadedModels: deps.loaded }));
vi.mock('./cos.js', () => ({ getStatus: deps.status, getAllTasks: deps.tasks }));

const { getActiveProcessing } = await import('./activeProcessing.js');

describe('active processing snapshot', () => {
  beforeEach(() => {
    Object.values(deps).forEach((mock) => mock.mockReset());
  });

  it('reports sanitized audio work, GPU utilization, and non-media extras', async () => {
    deps.capability.mockResolvedValue({ status: 'available', gpus: [{ name: 'Example GPU', vramMib: 24000 }] });
    deps.utilization.mockResolvedValue({ status: 'available', gpus: [{ name: 'Example GPU', utilizationPercent: 44, memoryUsedMib: 1000, memoryTotalMib: 24000 }] });
    deps.jobs.mockReturnValue([{ id: 'audio-1', kind: 'audio', status: 'running', params: { prompt: 'fake', musicStudio: { trackId: 'track-1' }, secretPath: '/private' } }]);
    deps.running.mockReturnValue({ kind: 'audio' });
    deps.models.mockResolvedValue([{ id: 'mesh-1', name: 'Fake mesh', status: 'generating' }]);
    deps.loaded.mockResolvedValue([{ id: 'model-1', name: 'Fake model' }]);
    deps.status.mockResolvedValue({ activeAgents: 2 });
    deps.tasks.mockResolvedValue({ user: { tasks: [{ status: 'pending' }] }, cos: { tasks: [{ status: 'completed' }] } });
    const snapshot = await getActiveProcessing();
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.gpu).toMatchObject({ status: 'available', laneBusy: true, laneKind: 'audio' });
    expect(snapshot.gpu.gpus[0]).toMatchObject({ utilizationPercent: 44, memoryUsedMib: 1000 });
    expect(snapshot.extras.imageTo3d).toEqual([{ id: 'mesh-1', name: 'Fake mesh' }]);
    expect(snapshot.extras.ollama).toEqual([{ id: 'model-1', name: 'Fake model' }]);
    expect(snapshot.agents).toEqual({ active: 2, queued: 1 });
  });

  it('preserves an absent GPU as a real negative state without probing utilization', async () => {
    deps.capability.mockResolvedValue({ status: 'absent', gpus: [] });
    deps.jobs.mockReturnValue([]);
    deps.running.mockReturnValue(null);
    deps.models.mockResolvedValue([]);
    deps.loaded.mockResolvedValue([]);
    deps.status.mockResolvedValue({ activeAgents: 0 });
    deps.tasks.mockResolvedValue({ user: {}, cos: {} });
    const snapshot = await getActiveProcessing();
    expect(snapshot.gpu).toMatchObject({ status: 'absent', laneBusy: false, laneKind: null, gpus: [] });
    expect(deps.utilization).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getProjectMock = vi.fn();
const updateProjectMock = vi.fn(async () => ({}));
const updateRunMock = vi.fn(async () => ({}));
vi.mock('./local.js', () => ({
  getProject: (...a) => getProjectMock(...a),
  updateProject: (...a) => updateProjectMock(...a),
  updateRun: (...a) => updateRunMock(...a),
}));

const getActiveAgentsMock = vi.fn(() => []);
const killAgentMock = vi.fn(async () => ({ success: true }));
vi.mock('../agentManagement.js', () => ({
  getActiveAgents: (...a) => getActiveAgentsMock(...a),
  killAgent: (...a) => killAgentMock(...a),
}));

const updateTaskMock = vi.fn(async () => ({}));
vi.mock('../cos.js', () => ({ updateTask: (...a) => updateTaskMock(...a) }));

const listJobsMock = vi.fn(() => []);
const cancelJobMock = vi.fn(async () => ({}));
vi.mock('../mediaJobQueue/index.js', () => ({
  listJobs: (...a) => listJobsMock(...a),
  cancelJob: (...a) => cancelJobMock(...a),
}));

const { stopProject, retireRuns, inflightRuns, ownedLiveJobs } = await import('./stopProject.js');

const project = (over = {}) => ({ id: 'cd-1', status: 'planning', runs: [], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  getActiveAgentsMock.mockReturnValue([]);
  listJobsMock.mockReturnValue([]);
});

describe('inflightRuns', () => {
  it('keeps only non-terminal run rows', () => {
    const runs = [
      { runId: 'a', status: 'completed' },
      { runId: 'b', status: 'failed' },
      { runId: 'c', status: 'running' },
      { runId: 'd' },
    ];
    expect(inflightRuns({ runs }).map((r) => r.runId)).toEqual(['c', 'd']);
  });

  it('tolerates a project with no runs', () => {
    expect(inflightRuns(null)).toEqual([]);
    expect(inflightRuns({})).toEqual([]);
  });

  it('narrows to the requested kinds — an LLM-stage caller must not sweep up a render step', () => {
    const runs = [
      { runId: 'a', kind: 'plan', status: 'running' },
      { runId: 'b', kind: 'plan-step', status: 'running' },
      { runId: 'c', kind: 'treatment', status: 'running' },
      { runId: 'd', kind: 'plan', status: 'completed' },
    ];
    expect(inflightRuns({ runs }, ['treatment', 'plan']).map((r) => r.runId)).toEqual(['a', 'c']);
  });
});

describe('retireRuns', () => {
  it('kills the agent, retires the internal task, and settles the run — without touching the project or its jobs', async () => {
    getActiveAgentsMock.mockReturnValue([{ id: 'agent-live', taskId: 't1' }]);

    const result = await retireRuns('cd-1', {
      runs: [{ runId: 'r1', taskId: 't1', status: 'running' }],
      reason: 'Commission provider changed to lmstudio-tui',
    });

    expect(killAgentMock).toHaveBeenCalledExactlyOnceWith('agent-live');
    expect(updateTaskMock).toHaveBeenCalledExactlyOnceWith(
      't1',
      expect.objectContaining({ status: 'completed' }),
      'internal',
    );
    expect(updateRunMock).toHaveBeenCalledExactlyOnceWith('cd-1', 'r1', expect.objectContaining({
      status: 'failed', failureReason: 'Commission provider changed to lmstudio-tui',
    }));
    // The restart path re-advances the project itself — retireRuns must not park it.
    expect(updateProjectMock).not.toHaveBeenCalled();
    expect(cancelJobMock).not.toHaveBeenCalled();
    expect(result).toEqual({ runs: 1, tasks: 1, agents: 1 });
  });

  it('is a no-op with nothing to retire', async () => {
    const result = await retireRuns('cd-1', { runs: [] });
    expect(getActiveAgentsMock).not.toHaveBeenCalled();
    expect(updateRunMock).not.toHaveBeenCalled();
    expect(result).toEqual({ runs: 0, tasks: 0, agents: 0 });
  });
});

describe('ownedLiveJobs', () => {
  it('matches all three ownership conventions and only live jobs', () => {
    const jobs = [
      { id: 'j1', owner: 'cd-1', status: 'queued' },                    // not an owner form
      { id: 'j2', owner: 'cd:cd-1:scene-1', status: 'queued' },
      { id: 'j3', owner: 'creative-director:cd-1', status: 'running' },
      { id: 'j4', owner: 'cd:cd-1:scene-2', status: 'completed' },      // terminal
      { id: 'j5', owner: 'cd:cd-2:scene-1', status: 'queued' },         // other project
      { id: 'j6', status: 'queued' },                                   // ownerless, untagged
      // First-pass seed frames carry NO owner — they're tagged in params. A
      // 10-scene project enqueues ten of these up front, so missing them means
      // "Stop" cancels nothing on exactly the projects with the most queued work.
      { id: 'j7', status: 'queued', params: { creativeDirector: { projectId: 'cd-1', sceneId: 's1' } } },
      { id: 'j8', status: 'running', params: { creativeDirector: { projectId: 'cd-2' } } }, // other project
      { id: 'j9', status: 'completed', params: { creativeDirector: { projectId: 'cd-1' } } }, // terminal
    ];
    expect(ownedLiveJobs(jobs, 'cd-1').map((j) => j.id)).toEqual(['j2', 'j3', 'j7']);
  });
});

describe('stopProject', () => {
  it('is a no-op for a missing project', async () => {
    getProjectMock.mockResolvedValue(null);
    const result = await stopProject('cd-gone');
    expect(result).toMatchObject({ stopped: false, skipped: 'missing' });
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it('never rewrites a terminal project', async () => {
    getProjectMock.mockResolvedValue(project({ status: 'complete' }));
    const result = await stopProject('cd-1');
    expect(result).toMatchObject({ stopped: false, skipped: 'terminal' });
    expect(updateProjectMock).not.toHaveBeenCalled();
  });

  it('parks the project, then settles the run, then kills — so neither the settle nor the kill echo can un-park it', async () => {
    const order = [];
    updateProjectMock.mockImplementation(async () => { order.push('park'); });
    updateRunMock.mockImplementation(async () => { order.push('settle-run'); });
    killAgentMock.mockImplementation(async () => { order.push('kill'); return { success: true }; });
    getProjectMock.mockResolvedValue(project({ runs: [{ runId: 'r1', taskId: 't1', status: 'running' }] }));
    getActiveAgentsMock.mockReturnValue([{ id: 'agent-live', taskId: 't1' }]);

    await stopProject('cd-1', { reason: 'Commission deleted' });

    // The run must be terminal before the kill: killAgent fires the agent
    // completion path, whose `!success` branch would otherwise flip the project to
    // `failed`. completionHook's stale-completion guard keys on that terminal row.
    expect(order).toEqual(['park', 'settle-run', 'kill']);
    expect(updateProjectMock).toHaveBeenCalledExactlyOnceWith('cd-1', { status: 'paused', failureReason: 'Commission deleted' });
  });

  it('kills live agents, retires the internal tasks, settles runs, and cancels media jobs', async () => {
    getProjectMock.mockResolvedValue(project({
      runs: [
        { runId: 'r1', taskId: 'cd-1-plan-a', status: 'running' },
        { runId: 'r2', taskId: 'cd-1-plan-old', status: 'completed' },
      ],
    }));
    getActiveAgentsMock.mockReturnValue([
      { id: 'agent-live', taskId: 'cd-1-plan-a' },
      { id: 'agent-other', taskId: 'unrelated-task' },
    ]);
    listJobsMock.mockReturnValue([
      { id: 'j2', owner: 'cd:cd-1:scene-1', status: 'running' },
      { id: 'j5', owner: 'cd:cd-2:scene-1', status: 'queued' },
    ]);

    const result = await stopProject('cd-1', { reason: 'Creative commission paused' });

    expect(killAgentMock).toHaveBeenCalledExactlyOnceWith('agent-live');
    // 'internal' + a supported terminal status — see recovery.js for why both matter.
    expect(updateTaskMock).toHaveBeenCalledExactlyOnceWith(
      'cd-1-plan-a',
      expect.objectContaining({ status: 'completed' }),
      'internal',
    );
    // Only the in-flight run is settled; the already-completed one is untouched.
    expect(updateRunMock).toHaveBeenCalledExactlyOnceWith('cd-1', 'r1', expect.objectContaining({
      status: 'failed', failureReason: 'Creative commission paused',
    }));
    expect(cancelJobMock).toHaveBeenCalledExactlyOnceWith('j2');
    expect(result).toMatchObject({ stopped: true, runs: 1, tasks: 1, agents: 1, jobs: 1 });
  });

  it('completes the stop when a single step fails', async () => {
    getProjectMock.mockResolvedValue(project({ runs: [{ runId: 'r1', taskId: 't1', status: 'running' }] }));
    getActiveAgentsMock.mockReturnValue([{ id: 'agent-live', taskId: 't1' }]);
    killAgentMock.mockRejectedValue(new Error('agent gone'));
    updateTaskMock.mockRejectedValue(new Error('task file busy'));
    listJobsMock.mockReturnValue([{ id: 'j2', owner: 'creative-director:cd-1', status: 'queued' }]);

    const result = await stopProject('cd-1');

    // A failed kill/retire must not abort the rest of the teardown.
    expect(updateRunMock).toHaveBeenCalled();
    expect(cancelJobMock).toHaveBeenCalledWith('j2');
    expect(result).toMatchObject({ stopped: true, agents: 0, tasks: 0, jobs: 1 });
  });

  it('skips the agent/task teardown entirely when no run carries a taskId', async () => {
    getProjectMock.mockResolvedValue(project({ runs: [{ runId: 'r1', kind: 'plan-step', status: 'running' }] }));
    await stopProject('cd-1');
    expect(getActiveAgentsMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledWith('cd-1', 'r1', expect.objectContaining({ status: 'failed' }));
  });
});

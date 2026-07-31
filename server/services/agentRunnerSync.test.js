import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoveredPty = {
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('./cosRunnerClient.js', () => ({
  getActiveAgentsFromRunner: vi.fn(),
  connectTuiSessionViaRunner: vi.fn(() => ({
    sessionId: 'tui-session-1',
    pid: 1234,
    ptyProcess: recoveredPty,
  })),
}));

vi.mock('./shell.js', () => ({
  getSession: vi.fn(),
  registerExternalSession: vi.fn(),
  unregisterExternalSession: vi.fn(),
}));

vi.mock('./cos.js', () => ({
  getAllTasks: vi.fn().mockResolvedValue({
    user: { grouped: { active: [{ id: 'task-1', description: 'Example task' }] } },
    cos: { grouped: {} },
  }),
}));

vi.mock('./cosAgents.js', () => ({
  getAgent: vi.fn(),
}));

import { connectTuiSessionViaRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import * as shellService from './shell.js';
import { getAgent } from './cosAgents.js';
import { runnerAgents } from './agentState.js';
import { syncRunnerAgents } from './agentRunnerSync.js';

describe('syncRunnerAgents runner-owned TUI recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerAgents.clear();
    vi.mocked(shellService.getSession).mockReturnValue(null);
    vi.mocked(getAgent).mockResolvedValue(null);
  });

  it('reconciles one surviving TUI and restores its attachable shell relay', async () => {
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-1',
      taskId: 'task-1',
      pid: 1234,
      startedAt: Date.now(),
      kind: 'tui',
      sessionId: 'tui-session-1',
      command: 'codex',
      workspacePath: '/tmp/example-workspace',
    }]);

    await expect(syncRunnerAgents()).resolves.toBe(1);

    expect(runnerAgents.has('agent-1')).toBe(true);
    expect(connectTuiSessionViaRunner).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'tui-session-1',
      pid: 1234,
    }));
    expect(shellService.registerExternalSession).toHaveBeenCalledWith(
      'tui-session-1',
      recoveredPty,
      expect.objectContaining({
        agentId: 'agent-1',
        kind: 'agent-tui',
        command: 'codex',
      }),
    );
  });

  // #3244. The runner's /agents response describes the live process and carries
  // no `metadata`, so the run id has to come off the persisted agent record.
  // Dropping it left the survivor's run open forever and unbilled, because
  // `completeAgentRun` returns early on a null id — and survivors are the normal
  // case since #3202 made TUI agents durable.
  it('recovers the run id and model from the persisted agent record', async () => {
    vi.mocked(getAgent).mockResolvedValue({
      id: 'agent-1',
      metadata: { runId: 'run-abc123', model: 'claude-opus-5' },
    });
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-1', taskId: 'task-1', pid: 1234, startedAt: Date.now(), kind: 'cli',
    }]);

    await expect(syncRunnerAgents()).resolves.toBe(1);

    expect(getAgent).toHaveBeenCalledWith('agent-1');
    expect(runnerAgents.get('agent-1')).toMatchObject({
      runId: 'run-abc123',
      model: 'claude-opus-5',
    });
  });

  it('recovers with a null run id rather than throwing when the record is gone', async () => {
    // A record that cannot be read must not take the whole recovery sweep down
    // with it — the surviving agent still needs re-adopting so its completion
    // event lands. The run stays open, which the warning line says out loud.
    vi.mocked(getAgent).mockRejectedValue(new Error('metadata.json unreadable'));
    vi.mocked(getActiveAgentsFromRunner).mockResolvedValue([{
      id: 'agent-2', taskId: 'task-1', pid: 99, startedAt: Date.now(), kind: 'cli',
    }]);

    await expect(syncRunnerAgents()).resolves.toBe(1);
    expect(runnerAgents.get('agent-2')).toMatchObject({ runId: null });
  });
});

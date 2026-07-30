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

import { connectTuiSessionViaRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import * as shellService from './shell.js';
import { runnerAgents } from './agentState.js';
import { syncRunnerAgents } from './agentRunnerSync.js';

describe('syncRunnerAgents runner-owned TUI recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerAgents.clear();
    vi.mocked(shellService.getSession).mockReturnValue(null);
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
});

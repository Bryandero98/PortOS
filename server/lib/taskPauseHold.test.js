import { describe, it, expect } from 'vitest';
import {
  AGENT_PAUSED_CATEGORY,
  PAUSE_METADATA_KEYS,
  pauseMetadata,
  clearedPauseMetadata,
  isAgentPausedTask,
  isResumablePausedTask,
} from './taskPauseHold.js';

const pausedTask = (metadata = {}) => ({
  id: 'task-1',
  status: 'blocked',
  metadata: { blockedCategory: AGENT_PAUSED_CATEGORY, pausedAgentId: 'agent-1', ...metadata },
});

describe('pauseMetadata', () => {
  it('writes every key the clear knows about, so the two can never drift', () => {
    const armed = pauseMetadata({
      agentId: 'agent-1',
      pausedAt: '2026-08-10T00:00:00.000Z',
      workspacePath: '/w/agent-1',
      runId: 'run-1',
    });
    expect(Object.keys(armed).sort()).toEqual([...PAUSE_METADATA_KEYS].sort());
    expect(armed.pausedAgentId).toBe('agent-1');
  });

  // A null would survive updateTask's merge and serialize into TASKS.md as the
  // literal string "null", which reads back as a resume pointer to nowhere.
  it('omits the pointer keys a run without a worktree has nothing to put in', () => {
    const armed = pauseMetadata({ agentId: 'agent-1', pausedAt: '2026-08-10T00:00:00.000Z' });
    expect(armed).not.toHaveProperty('resumeWorkspacePath');
    expect(armed).not.toHaveProperty('resumeRunId');
  });
});

describe('clearedPauseMetadata', () => {
  it('releases every key as undefined — updateTask DELETES those, but keeps a null', () => {
    const cleared = clearedPauseMetadata();
    expect(Object.keys(cleared).sort()).toEqual([...PAUSE_METADATA_KEYS].sort());
    for (const key of PAUSE_METADATA_KEYS) {
      expect(cleared).toHaveProperty(key);
      expect(cleared[key]).toBeUndefined();
    }
  });
});

describe('isAgentPausedTask / isResumablePausedTask', () => {
  it('recognizes a live pause and its owner', () => {
    expect(isAgentPausedTask(pausedTask())).toBe(true);
    expect(isResumablePausedTask(pausedTask(), 'agent-1')).toBe(true);
  });

  it('rejects a pause a LATER agent now owns — requeueing would stomp that pause', () => {
    expect(isAgentPausedTask(pausedTask({ pausedAgentId: 'agent-2' }))).toBe(true);
    expect(isResumablePausedTask(pausedTask({ pausedAgentId: 'agent-2' }), 'agent-1')).toBe(false);
  });

  it('rejects a task that is no longer blocked, whatever its stale metadata says', () => {
    expect(isAgentPausedTask({ ...pausedTask(), status: 'in_progress' })).toBe(false);
    expect(isResumablePausedTask({ ...pausedTask(), status: 'pending' }, 'agent-1')).toBe(false);
  });

  it('rejects a task blocked for some other reason, and a missing task', () => {
    expect(isAgentPausedTask(pausedTask({ blockedCategory: 'max-retries' }))).toBe(false);
    expect(isAgentPausedTask(null)).toBe(false);
    expect(isResumablePausedTask(null, 'agent-1')).toBe(false);
  });

  // Guards against the `undefined === undefined` hole: an agent id we don't have
  // must never match a task that never recorded one.
  it('never matches on a missing agent id', () => {
    expect(isResumablePausedTask(pausedTask({ pausedAgentId: undefined }), undefined)).toBe(false);
  });
});

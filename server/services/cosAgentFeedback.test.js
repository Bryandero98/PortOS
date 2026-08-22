import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';


const mockCosState = vi.hoisted(() => ({
  // Use $TMPDIR (falls back to /tmp) rather than a hardcoded /private/tmp — the
  // latter exists on macOS (where /tmp symlinks to it) but not on Linux CI.
  agentsDir: `${process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp'}/portos-cos-feedback-test-${process.pid}`,
  state: null
}));

const mockAgentIndex = vi.hoisted(() => ({ entries: new Map() }));

vi.mock('./cosState.js', () => ({
  AGENTS_DIR: mockCosState.agentsDir,
  loadState: vi.fn(async () => mockCosState.state),
  saveState: vi.fn(),
  withStateLock: async (fn) => fn()
}));

vi.mock('./cosAgentIndex.js', () => ({
  loadAgentIndex: vi.fn(async () => mockAgentIndex.entries),
  getAgentDir: (agentId, dateBucket) => join(mockCosState.agentsDir, dateBucket || '', agentId)
}));

import { getFeedbackStats, getPendingAgentFeedbackCount } from './cosAgentFeedback.js';

describe('getPendingAgentFeedbackCount', () => {
  beforeEach(() => {
    mockCosState.state = { agents: {} };
    mockAgentIndex.entries = new Map();
  });

  afterAll(async () => {
    await rm(mockCosState.agentsDir, { recursive: true, force: true });
  });

  it('counts only unrated completed non-system manually-run agents for the feedback insight', async () => {
    mockCosState.state.agents = {
      'agent-unrated': { id: 'agent-unrated', status: 'completed', completedAt: '2026-08-01T10:00:00.000Z', metadata: { taskType: 'user' } },
      'agent-rated': { id: 'agent-rated', status: 'completed', metadata: { taskType: 'user' }, feedback: { rating: 'positive' } },
      'agent-system': { id: 'agent-system', taskId: 'sys-health-check', status: 'completed', metadata: { taskType: 'user' } },
      'agent-running': { id: 'agent-running', status: 'running', metadata: { taskType: 'user' } },
      'agent-scheduled': { id: 'agent-scheduled', status: 'completed', metadata: { taskType: 'internal' } }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('excludes system agents identified by id as well as taskId', async () => {
    mockCosState.state.agents = {
      'sys-nightly-sweep': { id: 'sys-nightly-sweep', status: 'completed', metadata: { taskType: 'user' } },
      'agent-real': { id: 'agent-real', status: 'completed', metadata: { taskType: 'user' } }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('excludes scheduled-task and autopilot agents (taskType internal) from the feedback ask', async () => {
    mockCosState.state.agents = {
      'agent-scheduled': { id: 'agent-scheduled', status: 'completed', metadata: { taskType: 'internal' } },
      'agent-manual': { id: 'agent-manual', status: 'completed', metadata: { taskType: 'user' } }
    };

    await expect(getPendingAgentFeedbackCount()).resolves.toBe(1);
  });

  it('returns 0 when nothing is awaiting a rating', async () => {
    await expect(getPendingAgentFeedbackCount()).resolves.toBe(0);
  });

  it('aggregates archived feedback and de-duplicates a live copy of the same agent', async () => {
    const dateBucket = '2026-08-01';
    const archived = [
      {
        id: 'agent-archived',
        metadata: { taskDescription: 'Fix the example bug' },
        feedback: { rating: 'negative', comment: 'The regression remained.', submittedAt: '2026-08-01T11:00:00.000Z' }
      },
      {
        id: 'agent-duplicate',
        metadata: { taskDescription: 'Write example tests' },
        feedback: { rating: 'positive', submittedAt: '2026-08-01T10:00:00.000Z' }
      }
    ];

    for (const agent of archived) {
      const dir = join(mockCosState.agentsDir, dateBucket, agent.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'metadata.json'), JSON.stringify(agent));
      mockAgentIndex.entries.set(agent.id, dateBucket);
    }

    mockCosState.state.agents = {
      'agent-duplicate': {
        ...archived[1],
        feedback: { rating: 'positive', submittedAt: '2026-08-01T12:00:00.000Z' }
      },
      'agent-live': {
        id: 'agent-live',
        metadata: { taskDescription: 'Document the example workflow' },
        feedback: { rating: 'neutral', submittedAt: '2026-08-01T13:00:00.000Z' }
      }
    };

    await expect(getFeedbackStats()).resolves.toEqual({
      total: 3,
      positive: 1,
      negative: 1,
      neutral: 1,
      satisfactionRate: 33,
      byTaskType: {
        'bug-fix': { positive: 0, negative: 1, neutral: 0, total: 1 },
        testing: { positive: 1, negative: 0, neutral: 0, total: 1 },
        documentation: { positive: 0, negative: 0, neutral: 1, total: 1 }
      },
      recentWithComments: [{
        agentId: 'agent-archived',
        taskDescription: 'Fix the example bug',
        rating: 'negative',
        comment: 'The regression remained.',
        submittedAt: '2026-08-01T11:00:00.000Z'
      }]
    });
  });
});

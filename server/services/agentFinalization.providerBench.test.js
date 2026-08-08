/**
 * Tests for the provider-sidelining finalizeAgent does on a failed run.
 *
 * The bug this covers: an `agy` (Antigravity) TUI agent that hits the
 * "We're finishing verifying your account eligibility" banner fails in ~3s —
 * correctly — but nothing marked the provider unavailable, so the very next
 * dequeued task resolved onto the same provider and died on the same banner.
 * A run of queued tasks would all fail in sequence. The eligibility signal now
 * carries `benchMs`, and finalizeAgent honors it via the generic
 * `markProviderUnavailable` marker so `resolveAgentProviderAndModel` routes the
 * retry to a fallback until the deadline auto-recovers the provider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/execGit.js', () => ({
  execGit: vi.fn(async () => ({ stdout: 'main\n', stderr: '', exitCode: 0 })),
}));
vi.mock('./github.js', () => ({
  findPullRequestForBranch: vi.fn(async () => ({ status: 'found', number: 1, url: 'u' })),
  ensureForgeReachable: vi.fn(async () => ({ ok: true, status: 'ok' })),
}));
vi.mock('./gitlab.js', () => ({ findMergeRequestForBranch: vi.fn() }));
vi.mock('./git.js', () => ({ resolveForgeForRepo: vi.fn(async () => ({ cli: 'gh' })) }));
vi.mock('./cosEvents.js', () => ({ emitLog: vi.fn() }));
vi.mock('./cosAgentLifecycle.js', () => ({
  getAgent: vi.fn(async () => null),
  updateAgent: vi.fn(async () => null),
  completeAgent: vi.fn(async () => null),
}));
vi.mock('./cos.js', () => ({ updateTask: vi.fn(async () => ({})) }));

const getActiveProviderMock = vi.fn(async () => null);
vi.mock('./providers.js', () => ({ getActiveProvider: (...a) => getActiveProviderMock(...a) }));

const markProviderUnavailableMock = vi.fn(async () => null);
const markProviderUsageLimitMock = vi.fn(async () => null);
vi.mock('./providerStatus.js', () => ({
  markProviderUsageLimit: (...a) => markProviderUsageLimitMock(...a),
  markProviderRateLimited: vi.fn(async () => null),
  markProviderUnavailable: (...a) => markProviderUnavailableMock(...a),
}));

vi.mock('./executionLanes.js', () => ({ release: vi.fn() }));
vi.mock('./toolStateMachine.js', () => ({ completeExecution: vi.fn(), errorExecution: vi.fn() }));
vi.mock('./agentErrorAnalysis.js', () => ({
  resolveFailedTaskUpdate: vi.fn(async () => ({ status: 'pending', metadata: {} })),
  resolveTypeFailureSignal: vi.fn(() => ({ record: 'skip' })),
}));
vi.mock('./agentRunTracking.js', () => ({
  checkForTaskCommit: vi.fn(async () => false),
  createAgentRun: vi.fn(),
  completeAgentRun: vi.fn(async () => null),
}));
vi.mock('./taskTypeHooks.js', () => ({
  canRunTaskOutputHookWithoutPayload: vi.fn(() => false),
  isProgrammaticIoTaskType: vi.fn(() => false),
  resolveTaskHookType: vi.fn(() => null),
  declaresNoCommitCriterion: vi.fn(() => false),
  getTaskOutputHook: vi.fn(async () => null),
}));
vi.mock('./agentCompletion.js', () => ({ processAgentCompletion: vi.fn(async () => null) }));
vi.mock('./agentSummaryExtraction.js', () => ({ extractSimplifySummaries: vi.fn(() => null) }));

import { finalizeAgent } from './agentFinalization.js';
// The real detector and the real cooldown table supply the analysis shape and
// the window, so the assertions below can't drift from what actually ships.
import { detectImmediateFallbackSignal } from '../lib/aiToolkit/errorDetection.js';
import { COOLDOWN_MS_BY_CATEGORY } from '../lib/providerCooldown.js';

const failedRun = (errorAnalysis, providerId = 'antigravity-tui') => finalizeAgent({
  agentId: 'agent-1',
  task: { id: 'task-1', taskType: 'internal', description: 'do a thing', metadata: {} },
  runId: 'run-1',
  providerId,
  success: false,
  exitCode: 1,
  duration: 3000,
  outputBuffer: '',
  errorAnalysis,
  terminatedByUser: false,
  isTruthyMetaFn: () => false,
  error: errorAnalysis?.message,
  completionReason: 'fallback-signal',
  workspacePath: '/w',
  prExpected: false,
});

beforeEach(() => vi.clearAllMocks());

describe('finalizeAgent provider sidelining', () => {
  it('benches the provider on the agy eligibility signal', async () => {
    const analysis = detectImmediateFallbackSignal(
      "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly."
    );
    await failedRun(analysis);

    expect(markProviderUnavailableMock).toHaveBeenCalledWith('antigravity-tui', {
      reason: 'auth-error',
      message: analysis.message,
      waitTimeMs: COOLDOWN_MS_BY_CATEGORY['auth-error'],
    });
    // Before this fix only usage-limit/rate-limit benched, so an auth-error left
    // the provider healthy and the next dequeued task died on the same banner.
    expect(markProviderUsageLimitMock).not.toHaveBeenCalled();
  });

  it('leaves the usage-limit marker owning its own cooldown', async () => {
    await failedRun({
      hasError: true,
      category: 'usage-limit',
      origin: 'provider',
      message: 'hit your usage limit',
      requiresFallback: true,
    }, 'claude-code-tui');

    // markUsageLimit parses its own window out of the provider's message, so it
    // keeps the dedicated marker rather than the flat per-category cooldown.
    expect(markProviderUsageLimitMock).toHaveBeenCalledWith('claude-code-tui', expect.objectContaining({
      category: 'usage-limit',
    }));
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
  });

  // The provenance gate (#2642): a repainted TUI transcript is a whole session
  // of text the agent itself wrote, so a loose keyword match must never bench a
  // healthy provider — only structured provider chrome does.
  it('does not bench an output-scan failure that merely looks provider-ish', async () => {
    await failedRun({ hasError: true, category: 'auth-error', origin: 'output-scan', message: 'unauthorized' });
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
    expect(markProviderUsageLimitMock).not.toHaveBeenCalled();
    // No marker fired, so the lazy active-provider lookup must stay unread.
    expect(getActiveProviderMock).not.toHaveBeenCalled();
  });

  it('does not bench an ordinary agent-work failure', async () => {
    await failedRun({ hasError: true, category: 'test-failure', origin: 'output-scan', message: 'suite failed' });
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
    expect(markProviderUsageLimitMock).not.toHaveBeenCalled();
  });

  // A bad model id is REQUEST-specific: benching would take the provider's other
  // working models offline over one wrong id.
  it('does not bench a provider-origin model-not-found', async () => {
    await failedRun({ hasError: true, category: 'model-not-found', origin: 'provider', message: 'no such model' });
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
  });

  it('does not bench when the user terminated the run', async () => {
    const analysis = detectImmediateFallbackSignal(
      "We're finishing verifying your account eligibility. This usually takes a moment. Please try again shortly."
    );
    await finalizeAgent({
      agentId: 'agent-2',
      task: { id: 'task-2', taskType: 'internal', description: 'x', metadata: {} },
      runId: 'run-2',
      providerId: 'antigravity-tui',
      success: false,
      exitCode: 130,
      duration: 10,
      outputBuffer: '',
      errorAnalysis: analysis,
      terminatedByUser: true,
      isTruthyMetaFn: () => false,
      completionReason: 'terminated',
      workspacePath: '/w',
      prExpected: false,
    });
    expect(markProviderUnavailableMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';

// Drive getTaskPrompt with a controlled template so the REAL
// resolvePromptPlaceholders (and the real PATHS.worktrees) do the work, without
// touching persisted schedule state. getTaskInterval is the only taskSchedule
// export taskPromptService imports.
vi.mock('./taskSchedule.js', () => ({
  getTaskInterval: vi.fn(async () => ({ prompt: 'before {worktreesRoot}/claim-x after' })),
}));

import { getTaskPrompt, getStagePrompt, DEFAULT_TASK_PROMPTS, PREVIOUS_DEFAULT_PROMPTS } from './taskPromptService.js';
import { getTaskInterval } from './taskSchedule.js';
import { PATHS } from '../lib/fileUtils.js';

describe('taskPromptService {worktreesRoot} substitution', () => {
  it('resolves {worktreesRoot} to PATHS.worktrees (PortOS shared dir), leaving no literal placeholder', async () => {
    // PATHS.worktrees is PortOS's own shared worktrees dir — an absolute path
    // ending in data/cos/worktrees — NOT a repo-relative one.
    // Accept either separator: PATHS.worktrees is composed with path.join, so
    // it ends in `data\cos\worktrees` on Windows.
    expect(PATHS.worktrees).toMatch(/[\\/]data[\\/]cos[\\/]worktrees$/);

    const out = await getTaskPrompt('claim-issue');
    expect(out).toBe(`before ${PATHS.worktrees}/claim-x after`);
    expect(out).not.toContain('{worktreesRoot}');
  });
});

describe('claim-flow prompt variants', () => {
  it('keeps scheduled plan-task review-free while manual PLAN claims retain review guidance', async () => {
    getTaskInterval.mockResolvedValue({ prompt: null });

    const scheduled = await getTaskPrompt('plan-task');
    const manual = await getTaskPrompt('plan-task', { claimFlow: true });

    expect(scheduled).not.toContain('## Phase 6 — Review locally');
    expect(scheduled).toContain('gh pr checks <num> --required --watch --fail-fast');
    const expectedManual = PREVIOUS_DEFAULT_PROMPTS['plan-task'].at(-1)
      .replace(/\{worktreesRoot\}/g, PATHS.worktrees);
    expect(manual).toBe(expectedManual);
    expect(manual).toContain('## Phase 6 — Review locally');
    expect(manual).toContain('{reviewers}');
  });

  it('treats a persisted shipped default as non-customized for manual PLAN claims', async () => {
    getTaskInterval.mockResolvedValue({ prompt: DEFAULT_TASK_PROMPTS['plan-task'], promptVersion: 18 });

    const manual = await getTaskPrompt('plan-task', { claimFlow: true });

    expect(manual).toContain('## Phase 6 — Review locally');
    expect(manual).toContain('{reviewers}');
  });

  it('preserves a genuinely customized persisted prompt for manual claims', async () => {
    getTaskInterval.mockResolvedValue({ prompt: 'custom claim prompt' });

    await expect(getTaskPrompt('plan-task', { claimFlow: true })).resolves.toBe('custom claim prompt');
  });
});

// A pipeline STAGE body (pr-reviewer-security, code-reviewer-review, …) is read
// straight out of the catalog by its promptKey — it is never persisted and never
// versioned, which is why editing one takes no PROMPT_VERSIONS bump and no
// PREVIOUS_DEFAULT_PROMPTS entry (see taskPromptDefaults.test.js). That decision
// is only safe while stage resolution ignores stored schedule state, so pin the
// behavior rather than restating the absent constant: hand getStagePrompt an
// interval carrying a STALE persisted prompt and assert the current catalog body
// still wins.
describe('getStagePrompt reads stage bodies from the catalog, not from stored state', () => {
  it('ignores a stale persisted prompt on the pipeline task and returns the current stage default', async () => {
    getTaskInterval.mockResolvedValueOnce({
      prompt: 'STALE PERSISTED BODY that an install upgraded past long ago',
      promptVersion: 1,
      taskMetadata: {
        pipeline: {
          stages: [
            { name: 'Security Scan', promptKey: 'pr-reviewer-security' },
            { name: 'Code Review & Merge', promptKey: 'pr-reviewer-review' },
          ],
        },
      },
    });

    const stage = await getStagePrompt('pr-reviewer', 0);
    // Byte-identical, not merely similar: resolvePromptPlaceholders only rewrites
    // {worktreesRoot} / {reviewChecklist} / {slashdoReplan}, none of which this
    // body carries, so nothing stands between the catalog and the caller.
    expect(stage).toBe(DEFAULT_TASK_PROMPTS['pr-reviewer-security']);
    expect(stage).not.toContain('STALE PERSISTED BODY');
  });

  it('falls back to the task prompt only when the stage carries no promptKey', async () => {
    // Queued TWICE on purpose: the fallback path re-enters getTaskInterval via
    // getTaskPrompt, so one …Once would be consumed before the fallback runs and
    // the assertion would read the module-level default instead. …Once (not
    // mockResolvedValue) keeps the override from leaking into later tests.
    const unkeyed = {
      prompt: 'the task-level body',
      taskMetadata: { pipeline: { stages: [{ name: 'Unkeyed' }] } },
    };
    getTaskInterval.mockResolvedValueOnce(unkeyed).mockResolvedValueOnce(unkeyed);

    await expect(getStagePrompt('pr-reviewer', 0)).resolves.toBe('the task-level body');
  });
});

// Every override above is …Once, but reset anyway: a future test that reaches for
// mockResolvedValue would otherwise silently replace the module-level default for
// everything declared after it.
afterEach(() => {
  vi.mocked(getTaskInterval).mockReset();
  vi.mocked(getTaskInterval).mockResolvedValue({ prompt: 'before {worktreesRoot}/claim-x after' });
});

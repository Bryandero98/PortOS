import { describe, expect, it } from 'vitest';
import { PR_COMPLETIONS, PR_CREATION, resolvePrCompletion, resolvePrCreation } from './prDisposition.js';

describe('resolvePrCompletion', () => {
  it('prefers an explicit valid disposition', () => {
    expect(resolvePrCompletion({ prCompletion: PR_COMPLETIONS.LEAVE_OPEN, reviewLoop: true }))
      .toBe(PR_COMPLETIONS.LEAVE_OPEN);
  });

  it.each([
    [{ openPR: true, reviewLoop: true }, PR_COMPLETIONS.REVIEW_THEN_MERGE],
    [{ openPR: true, reviewLoop: 'true' }, PR_COMPLETIONS.REVIEW_THEN_MERGE],
    [{ openPR: true, reviewLoop: false }, PR_COMPLETIONS.MERGE_ON_GREEN],
    [{ openPR: true }, PR_COMPLETIONS.MERGE_ON_GREEN],
  ])('preserves legacy behavior for %o', (metadata, expected) => {
    expect(resolvePrCompletion(metadata)).toBe(expected);
  });

  it('falls back to legacy behavior when an unrecognized value is stored', () => {
    expect(resolvePrCompletion({ prCompletion: 'later', reviewLoop: true }))
      .toBe(PR_COMPLETIONS.REVIEW_THEN_MERGE);
  });
});

describe('resolvePrCreation (#3733)', () => {
  it('never creates one for a task that asked for no PR', () => {
    expect(resolvePrCreation({ taskOpenPR: false, agentOwnsPr: false, prClaimVerified: false })).toBe(PR_CREATION.NEVER);
    // …even if the agent would otherwise have owned it.
    expect(resolvePrCreation({ taskOpenPR: false, agentOwnsPr: true, prClaimVerified: false })).toBe(PR_CREATION.NEVER);
  });

  it('creates one outright when PortOS owns the lifecycle (a lean --bare session)', () => {
    expect(resolvePrCreation({ taskOpenPR: true, agentOwnsPr: false, prClaimVerified: false })).toBe(PR_CREATION.ALWAYS);
  });

  it('backstops an owner finalize did NOT verify — the slashdo-free harnesses', () => {
    expect(resolvePrCreation({ taskOpenPR: true, agentOwnsPr: true, prClaimVerified: false })).toBe(PR_CREATION.IF_MISSING);
  });

  it('stands down for an owner finalize already verified, rather than re-asking the forge', () => {
    // A slashdo-capable run that reaches cleanup as a success already passed
    // verifyPrClaim; a second `gh pr list` would be pure duplication.
    expect(resolvePrCreation({ taskOpenPR: true, agentOwnsPr: true, prClaimVerified: true })).toBe(PR_CREATION.NEVER);
  });
});

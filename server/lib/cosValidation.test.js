import { describe, it, expect } from 'vitest';
import {
  createCosTaskSchema,
  updateCosTaskSchema,
  createCosJobSchema,
  updateCosJobSchema,
  describeReviewerCli,
  isCliReviewer,
  reviewerCliBinary,
  DEFAULT_REVIEWER,
  LOCAL_LLM_REVIEWERS,
  REVIEWER_ALIASES,
  REVIEWER_CLI_BINARIES,
  REVIEWER_VALUES,
} from './cosValidation.js';
import { LOCAL_AGENT_REVIEWERS } from './slashdoInvocation.js';
import { EFFORT_LEVELS } from './providerModels.js';

describe('cosValidation effort field', () => {
  it('accepts every EFFORT_LEVELS value on create and rejects unknown values', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(createCosTaskSchema.safeParse({ description: 'x', effort }).success).toBe(true);
    }
    expect(createCosTaskSchema.safeParse({ description: 'x', effort: 'bogus' }).success).toBe(false);
  });

  it("create: '' (the form's Default option) parses to absent, not a stored empty pin", () => {
    const parsed = createCosTaskSchema.parse({ description: 'x', effort: '' });
    expect('effort' in parsed && parsed.effort !== undefined).toBe(false);
  });

  it("update: ''/null survive as null so the API can CLEAR a set effort pin", () => {
    // absent-vs-cleared (CLAUDE.md): the route gates on `!== undefined`, and the
    // store's legacy-field normalizer deletes a null pin — so the clear signal
    // must reach the route as null, not be preprocessed away to undefined.
    expect(updateCosTaskSchema.parse({ effort: '' }).effort).toBeNull();
    expect(updateCosTaskSchema.parse({ effort: null }).effort).toBeNull();
    expect(updateCosTaskSchema.parse({ effort: 'high' }).effort).toBe('high');
    expect(updateCosTaskSchema.parse({}).effort).toBeUndefined();
    expect(updateCosTaskSchema.safeParse({ effort: 'bogus' }).success).toBe(false);
  });
});

describe('cosValidation autonomous-job effort field', () => {
  it('accepts every EFFORT_LEVELS value on create and rejects unknown values', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(createCosJobSchema.safeParse({ name: 'j', effort }).success).toBe(true);
    }
    expect(createCosJobSchema.safeParse({ name: 'j', effort: 'bogus' }).success).toBe(false);
  });

  it("mirrors providerId's clearable-null semantics: ''/null → null, absent → undefined", () => {
    // A job effort pin is clearable through a PUT the same way providerId is —
    // '' from the UI picker and an explicit null both persist as null so
    // updateJob (which skips only `undefined`) resets the pin to the provider
    // default; an omitted key stays undefined and preserves the existing value.
    expect(createCosJobSchema.parse({ name: 'j', effort: '' }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: '' }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: null }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: 'max' }).effort).toBe('max');
    expect(updateCosJobSchema.parse({}).effort).toBeUndefined();
    expect(updateCosJobSchema.safeParse({ effort: 'bogus' }).success).toBe(false);
  });
});

describe('cosValidation job taskMetadata.worktreeChangesExpected (#3102)', () => {
  it('accepts the flag and preserves an explicit false (schema parity with the sanitizer)', () => {
    // Zod strips undeclared keys, so an unlisted flag would be silently dropped
    // from a job's taskMetadata — the opt-out has to be declared here too.
    const parsed = createCosJobSchema.parse({
      name: 'j',
      taskMetadata: { useWorktree: true, worktreeChangesExpected: false },
    });
    expect(parsed.taskMetadata).toEqual({ useWorktree: true, worktreeChangesExpected: false });
    expect(createCosJobSchema.safeParse({ name: 'j', taskMetadata: { worktreeChangesExpected: 'nope' } }).success)
      .toBe(false);
  });
});

describe('cosValidation reviewer CLI binaries', () => {
  // The bug this exists to prevent: `antigravity` is the stored, federated
  // reviewer identity, but the shipped executable is `agy` — no `antigravity`
  // command exists. A review-loop follow-up agent handed the bare slug ran
  // `command -v antigravity`, got nothing, concluded "no reviewer is available",
  // self-reviewed, and merged its own PR.
  it('maps the antigravity slug (and its gemini alias) to the agy binary', () => {
    expect(reviewerCliBinary('antigravity')).toBe('agy');
    expect(reviewerCliBinary('gemini')).toBe('agy');
    expect(reviewerCliBinary('ANTIGRAVITY')).toBe('agy');
    expect(describeReviewerCli('antigravity')).toBe('`agy` (the `antigravity` reviewer)');
  });

  it('leaves same-named reviewers alone rather than restating the slug', () => {
    for (const slug of ['claude', 'codex', 'grok']) {
      expect(reviewerCliBinary(slug)).toBe(slug);
      expect(describeReviewerCli(slug)).toBe(`\`${slug}\``);
    }
  });

  it('returns null for reviewers that have no spawnable CLI', () => {
    // copilot is a GitHub API review; lmstudio/ollama go through
    // POST /api/code-review/local. Prompt builders must not tell an agent to
    // run these as commands.
    for (const slug of [DEFAULT_REVIEWER, ...LOCAL_LLM_REVIEWERS]) {
      expect(reviewerCliBinary(slug)).toBeNull();
    }
    expect(reviewerCliBinary(undefined)).toBeNull();
    expect(describeReviewerCli(undefined)).toBe('');
  });

  // Guard the guard: a NEW CLI reviewer added to REVIEWER_VALUES without a
  // binary mapping must be caught here rather than shipping another slug an
  // agent will fruitlessly probe for. Aliases resolve first, so `gemini` is not
  // itself expected in the map. Uses isCliReviewer rather than re-spelling the
  // exclusion, so a change to that rule can actually fail this test.
  it('every CLI reviewer in REVIEWER_VALUES maps to a binary', () => {
    const cliReviewers = REVIEWER_VALUES.filter(isCliReviewer);
    expect(cliReviewers.length).toBeGreaterThan(0);
    for (const slug of cliReviewers) {
      expect(reviewerCliBinary(slug), `reviewerCliBinary('${slug}')`).toBeTruthy();
    }
    for (const alias of Object.keys(REVIEWER_ALIASES)) {
      expect(reviewerCliBinary(alias)).toBe(reviewerCliBinary(REVIEWER_ALIASES[alias]));
    }
  });

  it('agrees with isCliReviewer on which reviewers are spawnable CLIs', () => {
    for (const slug of REVIEWER_VALUES) {
      expect(Boolean(reviewerCliBinary(slug)), slug).toBe(isCliReviewer(slug));
    }
    expect(isCliReviewer(DEFAULT_REVIEWER)).toBe(false);
    expect(LOCAL_LLM_REVIEWERS.some(isCliReviewer)).toBe(false);
  });

  // slashdoInvocation keeps its own copy of the roster to decide which slashdo
  // `lib/*` includes a reviewer needs. Two hand-maintained lists of the same
  // reviewers drift the moment one gains a member — the `grok` addition is the
  // precedent — so pin them to each other rather than making slashdoInvocation
  // import this module (cosValidation already imports IT, and a cycle here would
  // be worse than the duplication).
  it('matches slashdoInvocation LOCAL_AGENT_REVIEWERS', () => {
    expect([...LOCAL_AGENT_REVIEWERS].sort()).toEqual(Object.keys(REVIEWER_CLI_BINARIES).sort());
  });
});

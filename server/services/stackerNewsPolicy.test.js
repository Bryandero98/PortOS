import { describe, expect, it } from 'vitest';
import { combineStackerNewsModelResults, evaluateStackerNewsPolicy, parseStackerNewsModelResult, resolveStackerNewsRules } from './stackerNewsPolicy.js';

describe('Stacker News policy', () => {
  it('inherits account rules while allowing explicit territory scalar and budget overrides', () => {
    const rules = resolveStackerNewsRules(
      { tone: 'warm', disallowedThemes: ['spam'], actionBudget: { maxPerDay: 8 } },
      { tone: 'curatorial', disallowedThemes: ['plagiarism'], actionBudget: { maxPerDay: 2 } },
      true,
    );
    expect(rules.tone).toBe('curatorial');
    expect(rules.disallowedThemes).toEqual(['spam', 'plagiarism']);
    expect(rules.actionBudget.maxPerDay).toBe(2);
  });

  it('preserves account budgets when a territory omitted budget overrides', () => {
    const rules = resolveStackerNewsRules(
      { actionBudget: { maxPerHour: 1, maxPerDay: 1, minMinutesBetween: 60 } },
      { guidance: 'Community-specific guidance', actionBudget: {} },
      true,
    );
    expect(rules.actionBudget).toEqual({ maxPerHour: 1, maxPerDay: 1, minMinutesBetween: 60 });
  });

  it('rejects unknown model fields and model-proposed action names', () => {
    expect(() => parseStackerNewsModelResult({ classification: 'allowed', risk: 'low', summary: '', findings: [], suggestedAction: 'zap', tool: 'shell' })).toThrow();
  });

  it('keeps prompt-injection decisions deterministic', () => {
    expect(evaluateStackerNewsPolicy({ deterministic: { injectionMatches: ['ignore'] }, model: null, rules: {} })).toMatchObject({ decision: 'escalate', allowedAction: 'none' });
  });

  it('combines text and vision results conservatively', () => {
    const combined = combineStackerNewsModelResults(
      { classification: 'escalate', risk: 'high', summary: 'Text concern', findings: ['credential request'], suggestedAction: 'none' },
      { classification: 'allowed', risk: 'low', summary: 'Image is ordinary', findings: [], suggestedAction: 'draft_comment' },
    );
    expect(combined).toMatchObject({ classification: 'escalate', risk: 'high', suggestedAction: 'none' });
    expect(evaluateStackerNewsPolicy({ deterministic: { injectionMatches: [] }, model: combined, rules: {} })).toMatchObject({ decision: 'escalate' });
  });
});

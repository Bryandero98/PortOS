import { describe, expect, it } from 'vitest';
import { evaluateStackerNewsPolicy, parseStackerNewsModelResult, resolveStackerNewsRules } from './stackerNewsPolicy.js';

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

  it('rejects unknown model fields and model-proposed action names', () => {
    expect(() => parseStackerNewsModelResult({ classification: 'allowed', risk: 'low', summary: '', findings: [], suggestedAction: 'zap', tool: 'shell' })).toThrow();
  });

  it('keeps prompt-injection decisions deterministic', () => {
    expect(evaluateStackerNewsPolicy({ deterministic: { injectionMatches: ['ignore'] }, model: null, rules: {} })).toMatchObject({ decision: 'escalate', allowedAction: 'none' });
  });
});

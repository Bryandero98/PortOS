import { describe, expect, it } from 'vitest';
import {
  buildRhetoricEvaluatorPrompt,
  buildRhetoricReferencePrompt,
  parseRhetoricJson,
  RHETORIC_REFERENCE_SET,
  RHETORIC_RUBRICS,
  scoreRhetoricReference,
  validateRhetoricEvaluationPayload,
} from './postRhetoric.js';

describe('rhetoric evaluator contract', () => {
  it('keeps a sizeable, fictional gold corpus across every practice mode', () => {
    expect(RHETORIC_REFERENCE_SET).toHaveLength(40);
    expect(new Set(RHETORIC_REFERENCE_SET.map((item) => item.mode))).toEqual(new Set(Object.keys(RHETORIC_RUBRICS)));
    expect(new Set(RHETORIC_REFERENCE_SET.map((item) => item.id)).size).toBe(40);
  });

  it('does not leak gold labels into the benchmark prompt', () => {
    const prompt = buildRhetoricReferencePrompt();
    expect(prompt).toContain('meter-01');
    expect(prompt).toContain('Return ONLY valid JSON');
    expect(prompt).not.toContain('"expectedScore"');
  });

  it('requires the exact rubric dimensions for an attempt', () => {
    const payload = validateRhetoricEvaluationPayload('meter', {
      overallScore: 82,
      dimensions: RHETORIC_RUBRICS.meter.map((criterion) => ({
        id: criterion.id,
        score: 82,
        feedback: 'Specific evidence.',
      })),
      summary: 'A credible line with a deliberate image.',
    });
    expect(payload.dimensions).toHaveLength(3);
    expect(() => validateRhetoricEvaluationPayload('meter', {
      ...payload,
      dimensions: payload.dimensions.slice(0, 2),
    })).toThrow(/wrong dimensions/i);
  });

  it('parses fenced evaluator JSON and scores perfect reference agreement', () => {
    const parsed = parseRhetoricJson('```json\n{"evaluations":[{"id":"x","score":50}]}\n```');
    expect(parsed.evaluations[0]).toEqual({ id: 'x', score: 50 });
    const scored = scoreRhetoricReference({
      evaluations: RHETORIC_REFERENCE_SET.map(({ id, expectedScore }) => ({ id, score: expectedScore })),
    });
    expect(scored.verdict).toBe('passed');
    expect(scored.meanAbsoluteError).toBe(0);
    expect(scored.within20Count).toBe(40);
  });

  it('marks broad calibration drift partial instead of treating one average as enough', () => {
    const scored = scoreRhetoricReference({
      evaluations: RHETORIC_REFERENCE_SET.map(({ id, expectedScore }) => ({ id, score: Math.max(0, expectedScore - 18) })),
    });
    expect(scored.verdict).toBe('partial');
    expect(scored.meanAbsoluteError).toBe(18);
    expect(scored.within20Count).toBe(40);
  });

  it('includes the selected attempt in the live evaluation prompt', () => {
    const prompt = buildRhetoricEvaluatorPrompt({ mode: 'chiasmus', prompt: 'Reverse a pair of terms.', response: 'We shape tools, and tools shape us.' });
    expect(prompt).toContain('Mode: chiasmus');
    expect(prompt).toContain('Reverse a pair of terms.');
    expect(prompt).toContain('We shape tools, and tools shape us.');
  });
});

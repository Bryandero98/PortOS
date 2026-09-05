import { describe, expect, it } from 'vitest';
import { createVideoDiagnosticTail, normalizeVideoFailure } from './videoFailure.js';

describe('local video diagnostic privacy boundary', () => {
  it('rejects generic exits and progress, retaining only a bounded useful final cause', () => {
    expect(normalizeVideoFailure('Exit code 1')).toBeNull();
    const tail = createVideoDiagnosticTail();
    tail.push('stderr', 'RuntimeError: obsolete exception\n');
    tail.push('stderr', 'x'.repeat(20000));
    tail.push('stdout', 'STAGE:load-model\nSTATUS:working\nprompt: RuntimeError: invented prose\n');
    expect(tail.summary()).toBeNull();
    tail.push('stderr', '\nRuntimeError: shader compilation failed');
    expect(tail.summary()).toBe('RuntimeError: shader compilation failed');
  });

  it('scrubs conditioning, tokens, credentials and POSIX/Windows paths before identity or display', () => {
    const token = `ghp_${'x'.repeat(30)}`;
    const error = `RuntimeError: failure for invented private prompt at /mock/private/model and C:\\mock\\model token=arbitrary ${token}`;
    const failure = normalizeVideoFailure(error, { prompts: ['invented private prompt'] });
    expect(failure.classification).toBe('runtimeerror');
    expect(failure.cause).not.toMatch(/invented|private|mock|arbitrary|ghp_/);
    expect(failure.cause.length).toBeLessThanOrEqual(240);
    expect(normalizeVideoFailure('RuntimeError: shape mismatch')).not.toEqual(normalizeVideoFailure('RuntimeError: shader compilation failed'));
    expect(normalizeVideoFailure("ModuleNotFoundError: No module named 'example_runtime'"))
      .toEqual({ classification: 'missing-module', cause: 'Python module example_runtime is missing' });
  });
});

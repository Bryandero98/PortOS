import { describe, it, expect } from 'vitest';
import {
  TUNING_SPECS,
  compareTunings,
  describeTuning,
  launchTuning,
  normalizeTuning,
  requestBody,
  tuningSignature,
  tuningSpecsFor,
} from './localModelTuning.js';

describe('TUNING_SPECS', () => {
  it('declares an applies mode for every knob', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      for (const spec of specs) {
        expect(['launch', 'request', 'record'], `${runtime}/${spec.id}`).toContain(spec.applies);
      }
    }
  });

  // A `request` knob with no wire name would be reported to the user as applied
  // while `requestBody` silently dropped it.
  it('gives every request-applied knob the field name the daemon reads', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      for (const spec of specs.filter((s) => s.applies === 'request')) {
        expect(spec.wire, `${runtime}/${spec.id}`).toBeTruthy();
      }
    }
  });

  it('only puts launch knobs on runtimes PortOS actually starts', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      if (runtime === 'llama') continue;
      expect(specs.some((s) => s.applies === 'launch'), runtime).toBe(false);
    }
  });

  it('returns an empty list for an unknown runtime rather than throwing', () => {
    expect(tuningSpecsFor('not-a-runtime')).toEqual([]);
  });
});

describe('normalizeTuning', () => {
  it('drops keys the runtime does not declare', () => {
    expect(normalizeTuning('llama', { ubatchSize: 512, rmRf: '/' })).toEqual({ ubatchSize: 512 });
  });

  it('clamps a number to its declared range', () => {
    expect(normalizeTuning('llama', { threads: 9999 })).toEqual({ threads: 256 });
    expect(normalizeTuning('llama', { threads: 0 })).toEqual({ threads: 1 });
  });

  it('rounds an integer knob rather than truncating — a launch line takes whole numbers', () => {
    expect(normalizeTuning('llama', { ubatchSize: 511.6 })).toEqual({ ubatchSize: 512 });
  });

  it('keeps a fractional knob fractional when the spec declares a step', () => {
    expect(normalizeTuning('vllm', { gpuMemoryUtilization: 0.85 })).toEqual({ gpuMemoryUtilization: 0.85 });
  });

  it('coerces the string booleans a form posts', () => {
    expect(normalizeTuning('llama', { flashAttn: 'true' })).toEqual({ flashAttn: true });
    expect(normalizeTuning('llama', { flashAttn: 'false' })).toEqual({ flashAttn: false });
  });

  it('rejects an enum value outside the declared options', () => {
    expect(normalizeTuning('llama', { cacheTypeK: 'q2_k' })).toEqual({});
    expect(normalizeTuning('llama', { cacheTypeK: 'q8_0' })).toEqual({ cacheTypeK: 'q8_0' });
  });

  // ABSENT is not zero. An empty field must leave the daemon on its own default
  // rather than pinning a value the user never chose.
  it.each([undefined, null, '', {}])('treats %p as "no tuning", not as zeroes', (input) => {
    expect(normalizeTuning('llama', input)).toEqual({});
  });

  it('drops a non-numeric value instead of recording NaN', () => {
    expect(normalizeTuning('llama', { threads: 'lots' })).toEqual({});
  });
});

describe('tuningSignature', () => {
  it('is empty for backend defaults, so a pre-tuning store key is unchanged', () => {
    expect(tuningSignature({})).toBe('');
    expect(tuningSignature(null)).toBe('');
  });

  it('is stable regardless of key order', () => {
    expect(tuningSignature({ ubatchSize: 512, threads: 8 }))
      .toBe(tuningSignature({ threads: 8, ubatchSize: 512 }));
  });

  it('separates two different tunings', () => {
    expect(tuningSignature({ ubatchSize: 512 })).not.toBe(tuningSignature({ ubatchSize: 256 }));
  });
});

describe('describeTuning', () => {
  it('renders labels in spec order with human units', () => {
    expect(describeTuning('llama', { flashAttn: true, ctxSize: 32768 }))
      .toBe('Context size 32k · Flash attention on');
  });

  it('is null for backend defaults so the caller can say so in its own words', () => {
    expect(describeTuning('llama', {})).toBeNull();
  });

  it('renders a false boolean as off, not as absent', () => {
    expect(describeTuning('llama', { flashAttn: false })).toBe('Flash attention off');
  });
});

describe('launchTuning / requestBody', () => {
  it('keeps only the knobs that reach the llama.cpp command line', () => {
    expect(launchTuning('llama', { ubatchSize: 512, cacheTypeK: 'q8_0' }))
      .toEqual({ ubatchSize: 512, cacheTypeK: 'q8_0' });
  });

  it('finds no launch knobs on a runtime PortOS does not start', () => {
    expect(launchTuning('ollama', { numCtx: 8192, numGpu: 40 })).toEqual({});
  });

  it('renders request knobs under the wire name the daemon reads', () => {
    expect(requestBody('ollama', { numCtx: 8192, numGpu: 40 })).toEqual({ num_ctx: 8192 });
  });

  it('sends nothing for a record-only runtime', () => {
    expect(requestBody('lmstudio', { contextLength: 8192 })).toEqual({});
  });
});

describe('compareTunings', () => {
  const measured = (tuning, charsPerSecond, extra = {}) => ({
    backend: 'llama',
    modelId: 'example-7b',
    tuning,
    performance: { meanCharsPerSecond: charsPerSecond, maxWorkingContextTokens: 16384 },
    assessedAt: '2026-08-01T00:00:00.000Z',
    ...extra,
  });

  it('ranks a model\'s tunings and reports each against the winner', () => {
    const [row] = compareTunings([
      measured({ ubatchSize: 256 }, 90),
      measured({ ubatchSize: 512 }, 120),
    ]);
    expect(row.modelId).toBe('example-7b');
    expect(row.best.charsPerSecond).toBe(120);
    expect(row.best.label).toBe('Micro-batch size 512');
    expect(row.variants.map((v) => v.deltaPercent)).toEqual([100, 75]);
  });

  it('labels the untuned variant as backend defaults rather than an empty string', () => {
    const [row] = compareTunings([measured({}, 120), measured({ ubatchSize: 512 }, 90)]);
    expect(row.best.label).toBe('Backend defaults');
  });

  // One reading is not a comparison. Presenting it as "the best tuning" would
  // dress a single measurement up as a conclusion.
  it('omits a model measured under only one tuning', () => {
    expect(compareTunings([measured({ ubatchSize: 512 }, 120)])).toEqual([]);
  });

  it('omits a variant that never produced throughput instead of scoring it zero', () => {
    expect(compareTunings([
      measured({ ubatchSize: 512 }, 120),
      measured({ ubatchSize: 256 }, null),
    ])).toEqual([]);
  });

  it('never mixes two models into one comparison', () => {
    const rows = compareTunings([
      measured({ ubatchSize: 512 }, 120),
      measured({ ubatchSize: 512 }, 40, { modelId: 'other-70b' }),
    ]);
    expect(rows).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  TUNING_SPECS,
  compareTunings,
  describeTuning,
  launchArgs,
  launchConfig,
  launchEnv,
  launchTuning,
  normalizeTuning,
  requestBody,
  tuningSignature,
  tuningSpecsFor,
} from './localModelTuning.js';

describe('TUNING_SPECS', () => {
  // The whole point of the catalog is learning which flags to pass a model, so a
  // knob PortOS cannot send teaches nothing. Every knob must name EXACTLY ONE
  // transport — none means it renders in the form, changes nothing, and the
  // reading is filed under a configuration that never existed; two means the
  // derived `applies` picks a winner nobody declared.
  it('gives every knob exactly one transport that reaches the daemon', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      for (const spec of specs) {
        const transports = [spec.wire, spec.env, spec.cli, spec.config].filter(Boolean);
        expect(transports, `${runtime}/${spec.id}`).toHaveLength(1);
      }
    }
  });

  // Derived, not declared — so a spec literal cannot disagree with itself.
  it('derives applies and the user-facing note from that transport', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      for (const spec of specs) {
        expect(spec.applies, `${runtime}/${spec.id}`).toBe(spec.wire ? 'request' : 'launch');
        expect(spec.note, `${runtime}/${spec.id}`).toBeTruthy();
      }
    }
  });

  it('names the flag or variable the knob becomes, not just that it is applied', () => {
    const byId = (runtime, id) => tuningSpecsFor(runtime).find((s) => s.id === id);
    expect(byId('ollama', 'flashAttention').note).toContain('OLLAMA_FLASH_ATTENTION');
    expect(byId('lmstudio', 'contextLength').note).toContain('lms load --context-length');
    expect(byId('llama', 'ubatchSize').note).toContain('launch line');
  });

  // Guard against a transport that is declared but renders nothing — the failure
  // a hand-maintained renderer switch would reintroduce.
  it('renders every knob through the renderer its transport names', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      for (const spec of specs) {
        const sample = { [spec.id]: spec.type === 'boolean' ? true : spec.type === 'enum' ? spec.options[0] : 1 };
        const rendered = Object.keys(launchEnv(runtime, sample)).length
          + launchArgs(runtime, sample).length
          + Object.keys(launchConfig(runtime, sample)).length
          + Object.keys(requestBody(runtime, sample)).length;
        expect(rendered, `${runtime}/${spec.id}`).toBeGreaterThan(0);
      }
    }
  });

  // PortOS passes MTPLX only --port/--model and does not start vLLM at all.
  it('offers no knob for a runtime PortOS has no launch path into', () => {
    expect(tuningSpecsFor('mtplx')).toEqual([]);
    expect(tuningSpecsFor('vllm')).toEqual([]);
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
    expect(normalizeTuning('lmstudio', { gpuOffload: 0.85 })).toEqual({ gpuOffload: 0.85 });
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

  it('ignores a key the runtime does not declare rather than inventing a label', () => {
    expect(describeTuning('llama', { somethingElse: 4 })).toBeNull();
  });
});

describe('launchTuning / launchConfig / launchEnv / launchArgs / requestBody', () => {
  it('keeps only the knobs that reach the llama.cpp command line', () => {
    expect(launchTuning('llama', { ubatchSize: 512, cacheTypeK: 'q8_0' }))
      .toEqual({ ubatchSize: 512, cacheTypeK: 'q8_0' });
  });

  it('renders llama.cpp knobs as the config object its manager relaunches with', () => {
    expect(launchConfig('llama', { ubatchSize: 512, cacheTypeK: 'q8_0' }))
      .toEqual({ ubatchSize: 512, cacheTypeK: 'q8_0' });
  });

  it('carries llama.cpp --parallel so a TUI-agent slot count can be measured', () => {
    expect(launchConfig('llama', { parallel: 1 })).toEqual({ parallel: 1 });
    expect(normalizeTuning('llama', { parallel: 0 })).toEqual({ parallel: 1 });
    expect(normalizeTuning('llama', { parallel: 99 })).toEqual({ parallel: 16 });
  });

  // A key no spec declares must never reach a launch line, whichever renderer
  // it is handed to.
  it('drops an undeclared key from every launch renderer', () => {
    expect(launchConfig('llama', { rmRf: '/' })).toEqual({});
    expect(launchEnv('ollama', { rmRf: '/' })).toEqual({});
    expect(launchArgs('lmstudio', { rmRf: '/' })).toEqual([]);
  });

  it('renders Ollama knobs as the daemon environment they only reach it through', () => {
    expect(launchEnv('ollama', { numCtx: 8192, flashAttention: true, kvCacheType: 'q8_0' })).toEqual({
      OLLAMA_CONTEXT_LENGTH: '8192',
      OLLAMA_FLASH_ATTENTION: '1',
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
    });
  });

  // Ollama parses 0/1, not JS `false` — and an explicitly-off toggle has to
  // survive as an override of a daemon default that may be on.
  it('renders a false toggle as 0 rather than dropping it', () => {
    expect(launchEnv('ollama', { flashAttention: false })).toEqual({ OLLAMA_FLASH_ATTENTION: '0' });
  });

  it('renders LM Studio knobs as the lms load flags that carry them', () => {
    expect(launchArgs('lmstudio', { contextLength: 8192, gpuOffload: 0.5 }))
      .toEqual(['--context-length', '8192', '--gpu', '0.5']);
  });

  it('renders lms flags in catalog order, whatever order the knobs were set in', () => {
    expect(launchArgs('lmstudio', { parallel: 2, contextLength: 8192 }))
      .toEqual(['--context-length', '8192', '--parallel', '2']);
  });

  it('renders nothing for a runtime whose knobs travel by another transport', () => {
    expect(launchArgs('ollama', { numCtx: 8192 })).toEqual([]);
    expect(launchEnv('lmstudio', { contextLength: 8192 })).toEqual({});
  });

  it('sends no request body for a runtime whose knobs are all launch-time', () => {
    expect(requestBody('ollama', { numCtx: 8192 })).toEqual({});
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

  // The record is the authority on the configuration it was measured under. A
  // knob that has since left the catalog would otherwise re-derive to "Backend
  // defaults", silently changing what a stored reading claims to be.
  it('shows the label the reading was measured under, not one re-derived today', () => {
    const [row] = compareTunings([
      measured({ someRetiredKnob: 8192 }, 120, { tuningLabel: 'Max KV size 8k' }),
      measured({ ubatchSize: 512 }, 90),
    ]);
    expect(row.best.label).toBe('Max KV size 8k');
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

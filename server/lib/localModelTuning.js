/**
 * Launch/runtime tuning knobs for the local model runtimes PortOS can measure.
 *
 * A measured assessment answers "how did this model behave here?". That question
 * is incomplete without "…configured how?" — the same GGUF on the same machine
 * streams at wildly different rates depending on the micro-batch size, whether
 * flash attention is on, and how much of the KV cache is quantized. Recording a
 * throughput number with no record of the launch line makes two readings of the
 * same model look like noise when they are actually two different setups.
 *
 * This module is the pure half of that: the per-runtime knob catalog, the
 * normalizer that turns a request body into a knob set, and the stable signature
 * that lets several tunings of ONE model coexist in the store and be ranked
 * against each other.
 *
 * ## `applies` — the honesty axis (read before adding a knob)
 *
 * Every knob declares what PortOS can actually DO with it:
 *
 *   - `'launch'`  — PortOS starts this daemon, so it puts the knob on the
 *                   command line (llama.cpp only today, via `llamaServerManager`).
 *   - `'request'` — PortOS sends it with each measurement request.
 *   - `'record'`  — PortOS cannot set it. The user states how the daemon was
 *                   launched so two readings are comparable.
 *
 * A `'record'` knob is NOT a lie by omission — it changes nothing about the run
 * and the UI says so. What it must never do is claim to have been applied. Do
 * not promote a knob to `'launch'`/`'request'` without a code path that sends it.
 *
 * ## The sentinel contract
 *
 * An ABSENT knob means "whatever the daemon defaults to", which is not a value
 * we can name — it is never coerced to 0, `false`, or a guessed default. That is
 * why `normalizeTuning` drops empty input instead of filling it in, and why the
 * signature of an untuned run is `''` (so its store key is byte-identical to the
 * pre-tuning key, and existing records keep resolving).
 */

/**
 * KV-cache quantization types llama.cpp accepts for `--cache-type-k/-v`. Kept to
 * the three that are universally compiled in; an exotic type the local build
 * lacks would make the server exit on launch, which reads to the user as "this
 * model does not fit".
 */
const CACHE_TYPES = ['f16', 'q8_0', 'q4_0'];

/**
 * Tuning knobs per runtime, in the order a UI should render them.
 *
 * `hint` is user-facing: it says what the knob trades away, because the point of
 * a tuning sweep is finding the trade that suits this machine, not maximizing
 * any single number.
 */
export const TUNING_SPECS = Object.freeze({
  llama: Object.freeze([
    { id: 'ctxSize', label: 'Context size', type: 'number', applies: 'launch', min: 512, max: 1048576, unit: 'tokens', hint: 'KV cache is allocated for the whole window up front — a larger one costs memory even when prompts are short.' },
    { id: 'nGpuLayers', label: 'GPU layers', type: 'number', applies: 'launch', min: 0, max: 999, hint: 'Layers offloaded to the GPU. Fewer layers frees VRAM for a bigger context at the cost of throughput.' },
    { id: 'batchSize', label: 'Batch size', type: 'number', applies: 'launch', min: 1, max: 8192, hint: 'Logical prompt batch (-b). Raising it speeds up prefill on long prompts and raises peak memory.' },
    { id: 'ubatchSize', label: 'Micro-batch size', type: 'number', applies: 'launch', min: 1, max: 8192, hint: 'Physical micro-batch (-ub). The single knob that most often moves long-context throughput.' },
    { id: 'threads', label: 'CPU threads', type: 'number', applies: 'launch', min: 1, max: 256, hint: 'Threads for the CPU-resident layers. More is not always faster once you pass the physical core count.' },
    { id: 'flashAttn', label: 'Flash attention', type: 'boolean', applies: 'launch', hint: 'Fused attention kernel. Usually faster and lighter on memory, but not every build/GPU supports it.' },
    { id: 'cacheTypeK', label: 'KV cache type (K)', type: 'enum', applies: 'launch', options: CACHE_TYPES, hint: 'Quantizing the key cache buys context length with a little quality.' },
    { id: 'cacheTypeV', label: 'KV cache type (V)', type: 'enum', applies: 'launch', options: CACHE_TYPES, hint: 'Quantizing the value cache buys context length with a little quality.' },
    { id: 'draftMax', label: 'Draft tokens', type: 'number', applies: 'launch', min: 0, max: 64, hint: 'Speculative-decoding lookahead. Only does anything when a drafter model is loaded.' },
  ]),
  ollama: Object.freeze([
    { id: 'numCtx', label: 'Context size', type: 'number', applies: 'request', wire: 'num_ctx', min: 512, max: 1048576, unit: 'tokens', hint: 'Sent with the measurement request as `num_ctx`.' },
    { id: 'numGpu', label: 'GPU layers', type: 'number', applies: 'record', min: 0, max: 999, hint: 'Set via the model\'s Modelfile or OLLAMA_NUM_GPU — recorded here so two readings are comparable.' },
    { id: 'numThread', label: 'CPU threads', type: 'number', applies: 'record', min: 1, max: 256, hint: 'Set outside PortOS; recorded so a thread-count change does not read as noise.' },
    { id: 'flashAttention', label: 'Flash attention', type: 'boolean', applies: 'record', hint: 'OLLAMA_FLASH_ATTENTION in the daemon\'s environment.' },
    { id: 'kvCacheType', label: 'KV cache type', type: 'enum', applies: 'record', options: CACHE_TYPES, hint: 'OLLAMA_KV_CACHE_TYPE in the daemon\'s environment.' },
  ]),
  lmstudio: Object.freeze([
    { id: 'contextLength', label: 'Context length', type: 'number', applies: 'record', min: 512, max: 1048576, unit: 'tokens', hint: 'Chosen in LM Studio when the model is loaded.' },
    { id: 'gpuOffloadLayers', label: 'GPU offload layers', type: 'number', applies: 'record', min: 0, max: 999, hint: 'LM Studio\'s GPU offload slider.' },
    { id: 'evalBatchSize', label: 'Eval batch size', type: 'number', applies: 'record', min: 1, max: 8192, hint: 'LM Studio\'s evaluation batch size.' },
    { id: 'flashAttention', label: 'Flash attention', type: 'boolean', applies: 'record', hint: 'LM Studio\'s flash-attention toggle.' },
  ]),
  mtplx: Object.freeze([
    { id: 'numDraftTokens', label: 'MTP draft tokens', type: 'number', applies: 'record', min: 0, max: 64, hint: 'Multi-token-prediction lookahead the server was started with.' },
    { id: 'maxKvSize', label: 'Max KV size', type: 'number', applies: 'record', min: 512, max: 1048576, unit: 'tokens', hint: 'KV cache ceiling on the launch line.' },
    { id: 'kvBits', label: 'KV cache bits', type: 'enum', applies: 'record', options: ['4', '8', '16'], hint: 'MLX KV-cache quantization width.' },
  ]),
  vllm: Object.freeze([
    { id: 'maxModelLen', label: 'Max model length', type: 'number', applies: 'record', min: 512, max: 1048576, unit: 'tokens', hint: '--max-model-len on the container launch line.' },
    { id: 'gpuMemoryUtilization', label: 'GPU memory utilization', type: 'number', applies: 'record', min: 0.1, max: 1, step: 0.05, hint: '--gpu-memory-utilization: the fraction of VRAM vLLM is allowed to claim.' },
    { id: 'maxNumSeqs', label: 'Max concurrent sequences', type: 'number', applies: 'record', min: 1, max: 1024, hint: '--max-num-seqs: batching width, which trades single-stream latency for throughput.' },
  ]),
});

/** Knob specs for one runtime, or `[]` for a runtime with none declared. */
export const tuningSpecsFor = (runtimeId) => TUNING_SPECS[runtimeId] || [];

const specById = (runtimeId, id) => tuningSpecsFor(runtimeId).find((s) => s.id === id) || null;

const clamp = (value, min, max) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));

/**
 * Coerce one raw value against its spec. Returns `undefined` for anything that
 * cannot be read as a value — which drops the knob entirely rather than
 * substituting a default the daemon never saw.
 */
function coerceValue(spec, raw) {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (spec.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  if (spec.type === 'enum') {
    const value = String(raw);
    return spec.options.includes(value) ? value : undefined;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return undefined;
  const clamped = clamp(num, spec.min, spec.max);
  // Integer knobs (everything but a utilization fraction) round rather than
  // truncate — a launch line takes whole numbers, and `-ub 511.6` is not a thing.
  return spec.step ? Number(clamped.toFixed(2)) : Math.round(clamped);
}

/**
 * Reduce a raw tuning object to the knobs this runtime declares, coerced and
 * clamped. Unknown keys are dropped silently: they cannot be applied, and
 * persisting them would put an un-renderable field in the store forever.
 *
 * @param {string} runtimeId
 * @param {object|null|undefined} tuning
 * @returns {object} `{}` when nothing usable was supplied — which means "daemon
 *   defaults", NOT "every knob set to zero".
 */
export function normalizeTuning(runtimeId, tuning) {
  if (!tuning || typeof tuning !== 'object') return {};
  const out = {};
  for (const spec of tuningSpecsFor(runtimeId)) {
    const value = coerceValue(spec, tuning[spec.id]);
    if (value !== undefined) out[spec.id] = value;
  }
  return out;
}

/**
 * Stable identity for a tuning set: sorted `id=value` pairs.
 *
 * `''` for an empty set — deliberately, so an untuned assessment keys exactly
 * as it did before tuning existed and every record already on disk keeps
 * resolving without a migration.
 */
export function tuningSignature(tuning) {
  const entries = Object.entries(tuning || {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',');
}

const formatValue = (spec, value) => {
  if (spec.type === 'boolean') return value ? 'on' : 'off';
  if (spec.type === 'number' && spec.unit === 'tokens' && value >= 1024) return `${Math.round(value / 1024)}k`;
  return String(value);
};

/**
 * Human label for a tuning set, e.g. `Context size 32k · Micro-batch size 512`.
 * `null` when nothing was tuned — the caller renders "backend defaults" rather
 * than an empty string that reads like a missing value.
 */
export function describeTuning(runtimeId, tuning) {
  const parts = tuningSpecsFor(runtimeId)
    .filter((spec) => tuning?.[spec.id] !== undefined && tuning?.[spec.id] !== null)
    .map((spec) => `${spec.label} ${formatValue(spec, tuning[spec.id])}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The subset of a tuning set PortOS puts on the daemon's command line. Empty for
 * every runtime PortOS does not start itself.
 */
export function launchTuning(runtimeId, tuning) {
  const out = {};
  for (const [id, value] of Object.entries(tuning || {})) {
    if (specById(runtimeId, id)?.applies === 'launch') out[id] = value;
  }
  return out;
}

/**
 * The request-applied knobs, rendered under their WIRE names, ready to merge
 * into a chat-completions body.
 *
 * The wire name lives on the spec rather than in a lookup table here so a knob
 * cannot be declared `applies: 'request'` without also declaring the field the
 * daemon reads — which would produce a knob that silently does nothing while the
 * UI reports it as applied.
 */
export function requestBody(runtimeId, tuning) {
  const out = {};
  for (const [id, value] of Object.entries(tuning || {})) {
    const spec = specById(runtimeId, id);
    if (spec?.applies === 'request' && spec.wire) out[spec.wire] = value;
  }
  return out;
}

const throughputOf = (a) => {
  const value = a?.performance?.meanCharsPerSecond;
  return Number.isFinite(value) ? value : null;
};

/**
 * Group measured assessments by (backend, model) and report which tuning won.
 *
 * Only models with TWO OR MORE tunings that both produced throughput appear: a
 * single reading has nothing to compare against, and presenting it as a "best
 * tuning" would dress one measurement up as a conclusion.
 *
 * `deltaPercent` is each variant's throughput relative to the winner, so the
 * table answers "was that knob worth it?" rather than just listing numbers.
 *
 * @param {Array<object>} assessments records from the store
 * @returns {Array<{backend:string, modelId:string, best:object, variants:Array<object>}>}
 */
export function compareTunings(assessments) {
  const groups = new Map();
  for (const assessment of Array.isArray(assessments) ? assessments : []) {
    if (!assessment?.backend || !assessment?.modelId) continue;
    if (throughputOf(assessment) === null) continue;
    const key = `${assessment.backend}:${assessment.modelId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(assessment);
  }

  const rows = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => throughputOf(b) - throughputOf(a));
    const winner = throughputOf(sorted[0]);
    rows.push({
      backend: sorted[0].backend,
      modelId: sorted[0].modelId,
      best: {
        tuning: sorted[0].tuning || {},
        label: describeTuning(sorted[0].backend, sorted[0].tuning) || 'Backend defaults',
        charsPerSecond: winner,
      },
      variants: sorted.map((a) => ({
        tuning: a.tuning || {},
        label: describeTuning(a.backend, a.tuning) || 'Backend defaults',
        charsPerSecond: throughputOf(a),
        maxWorkingContextTokens: Number.isFinite(a.performance?.maxWorkingContextTokens)
          ? a.performance.maxWorkingContextTokens
          : null,
        assessedAt: a.assessedAt || null,
        // Relative to the winner, so 100 is the best measured tuning and 74
        // means "a quarter slower than the best this model managed here".
        deltaPercent: winner > 0 ? Number(((throughputOf(a) / winner) * 100).toFixed(1)) : null,
      })),
    });
  }
  return rows.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

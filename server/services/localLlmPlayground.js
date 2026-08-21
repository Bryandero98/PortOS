import { ServerError } from '../lib/errorHandler.js';
import { createRun, finalizeRunRecord } from './runner.js';
import { ensureBackendProvider } from './localLlm.js';
import { getProviderById } from './providers.js';
import { markProviderAvailable } from './providerStatus.js';
import { ensureProviderReady as ensureOllamaProviderReady } from './ollamaManager.js';
import { anyAbortSignal } from '../lib/requestAbort.js';
// The SSE read loop lives in `lib/openAiChatStream.js` so the assessments
// service can measure a bare loopback daemon that has no provider record.
import { buildMessages, streamOpenAiChat } from '../lib/openAiChatStream.js';
import { assertSecretEndpoint } from '../lib/aiToolkit/internal/endpointGuard.js';

const PROVIDER_BY_BACKEND = { ollama: 'ollama', lmstudio: 'lmstudio' };

// Human-readable record of what was asked, stored on the run for /runs replay.
// This is NOT the wire format — the API receives the structured `buildMessages`
// array; the synthetic "System instructions:/User prompt:" framing here exists
// only so the run viewer shows one readable blob.
export function buildPrompt({ systemPrompt, prompt }) {
  const system = String(systemPrompt || '').trim();
  if (!system) return prompt;
  return `System instructions:\n${system}\n\nUser prompt:\n${prompt}`;
}

export function summarizeTimings({ startedAt, firstChunkAt, endedAt, text }) {
  const totalMs = endedAt - startedAt;
  const ttftMs = firstChunkAt ? firstChunkAt - startedAt : null;
  const chars = text.length;
  // A sub-millisecond total makes a rate meaningless — report n/a (null)
  // rather than `chars`, which would surface the char COUNT as a chars/sec rate.
  const charsPerSecond = totalMs > 0 ? Number((chars / (totalMs / 1000)).toFixed(2)) : null;
  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    ttftMs,
    totalMs,
    chars,
    charsPerSecond,
  };
}

async function resolveLocalProvider(backend) {
  const providerId = PROVIDER_BY_BACKEND[backend];
  if (!providerId) {
    throw new ServerError(`Unsupported local LLM backend: ${backend}`, { status: 400, code: 'VALIDATION_ERROR' });
  }

  await ensureBackendProvider(backend);
  const provider = await getProviderById(providerId);
  if (!provider) {
    throw new ServerError(`Local provider "${providerId}" is not configured`, { status: 503, code: 'LOCAL_LLM_PROVIDER_MISSING' });
  }
  if (provider.type !== 'api') {
    throw new ServerError(`Local provider "${providerId}" must be an API provider`, { status: 503, code: 'LOCAL_LLM_PROVIDER_INVALID' });
  }
  await markProviderAvailable(provider.id).catch(() => {});
  return provider;
}

async function streamChatCompletion({ provider, backend, modelId, prompt, systemPrompt, temperature, maxTokens, extraBody = {}, signal, onChunk }) {
  if (backend === 'ollama') {
    const ready = await ensureOllamaProviderReady(provider).catch((err) => ({ success: false, error: err.message }));
    if (!ready.success) {
      throw new Error(`Ollama is not running and PortOS could not start it: ${ready.error || 'unknown error'}`);
    }
  }

  // Guard before attaching the API key so a hostile/mistyped endpoint on the
  // (normally keyless) ollama/lmstudio provider records can't harvest a key
  // or reach a cloud-metadata service (SSRF). No-ops when apiKey is unset.
  assertSecretEndpoint(provider.endpoint, {
    hasSecret: Boolean(provider.apiKey),
    allowCustomEndpoint: provider.allowCustomEndpoint === true,
  });

  return streamOpenAiChat({
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    model: modelId,
    messages: buildMessages({ systemPrompt, prompt }),
    temperature,
    maxTokens,
    // The caller's knobs win over the provider default: an assessment measuring
    // a specific `num_ctx` must not silently be run at the provider's.
    extraBody: { ...(Number(provider.numCtx) > 0 ? { num_ctx: Number(provider.numCtx) } : {}), ...extraBody },
    signal,
    onChunk,
  });
}

export async function runLocalLlmTest({
  backend,
  modelId,
  prompt,
  systemPrompt = '',
  temperature = 0.3,
  maxTokens = 1000,
  timeoutMs = 300000,
  // Backend-specific request knobs merged into the chat-completions body (see
  // `lib/localModelTuning.js#requestBody`). Empty for a plain playground run.
  extraBody = {},
  signal: clientSignal,
  // Optional per-token callback `onToken(delta, kind)` where kind is 'content'
  // or 'reasoning'. When provided (streaming route), each delta is forwarded as
  // it arrives so the client can render live output (reasoning on its own
  // channel). The returned result is unchanged, so non-streaming callers ignore
  // this entirely.
  onToken,
}) {
  const provider = await resolveLocalProvider(backend);
  const fullPrompt = buildPrompt({ systemPrompt, prompt });
  const startedAt = Date.now();
  let firstChunkAt = null;
  let runId = null;

  try {
    const run = await createRun({
      providerId: provider.id,
      model: modelId,
      prompt: fullPrompt,
      source: 'local-llm-playground',
      timeout: timeoutMs,
    });
    runId = run.runId;
    if (run.usedFallback || run.provider?.id !== provider.id) {
      throw new Error(`Local LLM playground refused fallback provider for ${provider.id}`);
    }

    // The timeout controller aborts the upstream read (its plain AbortError keeps
    // the "Timed out after Xms" mapping below). A client disconnect — the user hit
    // Cancel, closing the browser fetch — aborts `clientSignal`; `anyAbortSignal`
    // composes both so whichever fires first tears down the upstream reader instead
    // of running on to the full timeout with no one listening.
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = anyAbortSignal([clientSignal, timeoutController.signal]);
    const text = await streamChatCompletion({
      provider,
      backend,
      modelId,
      prompt,
      systemPrompt,
      temperature,
      maxTokens,
      extraBody,
      signal,
      onChunk: (chunk, kind = 'content') => {
        // First token of EITHER channel marks TTFT: for a reasoning model the
        // first thing it emits is reasoning, so timing it from that chunk is the
        // honest time-to-first-token (previously reasoning-only runs reported a
        // null TTFT because reasoning never reached this callback).
        if (!firstChunkAt && chunk) firstChunkAt = Date.now();
        // Await the consumer so socket backpressure from the streaming route
        // propagates back up to the upstream read loop (pauses reading until the
        // client drains). Non-streaming callers pass no onToken, so this no-ops.
        if (chunk) return onToken?.(chunk, kind);
        return undefined;
      },
    }).finally(() => clearTimeout(timeoutHandle));

    const endedAt = Date.now();
    await finalizeRunRecord({ runId, output: text, exitCode: 0, success: true, startTime: startedAt });
    return {
      backend,
      modelId,
      providerId: provider.id,
      runId,
      text,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text }),
      options: { temperature, maxTokens, timeoutMs },
    };
  } catch (err) {
    const endedAt = Date.now();
    const error = err?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err?.message || 'Local LLM test failed';
    // A timeout/abort mid-stream still has tokens worth keeping — surface what the
    // model already streamed (attached to the error by streamChatCompletion) instead
    // of discarding it. Persist it on the failed run record too so /runs replay shows it.
    // (TTFT is recorded even for a reasoning-only partial now, since reasoning deltas
    // mark first-chunk timing too.)
    const partialText = typeof err?.partialOutput === 'string' ? err.partialOutput : '';
    if (runId) {
      await finalizeRunRecord({
        runId,
        output: partialText,
        exitCode: 1,
        success: false,
        error,
        startTime: startedAt,
      }).catch(() => {});
    }
    return {
      backend,
      modelId,
      providerId: provider.id,
      runId,
      error,
      text: partialText,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt, text: partialText }),
      options: { temperature, maxTokens, timeoutMs },
    };
  }
}

/**
 * Measure one generation against a bare OpenAI-compatible loopback daemon —
 * llama.cpp, MTPLX, or vLLM — that PortOS does NOT hold a provider record for.
 *
 * Returns the same shape as `runLocalLlmTest` (text / error / timings) so the
 * assessment sampler treats every runtime identically. What it deliberately
 * does NOT do is create a `/runs` record: `createRun` resolves a configured
 * provider, and inventing one for a daemon the user started outside PortOS
 * would put a phantom provider in the runs history.
 *
 * @param {object} options
 * @param {string} options.runtime runtime id, echoed back on the result
 * @param {string} options.endpoint OpenAI-compatible base ending in `/v1`
 */
export async function runEndpointLlmTest({
  runtime,
  endpoint,
  // Empty for the usual unauthenticated loopback daemon; set for a vLLM
  // container started behind `VLLM_API_KEY`, which 401s without it.
  apiKey = '',
  modelId,
  prompt,
  systemPrompt = '',
  temperature = 0.3,
  maxTokens = 1000,
  timeoutMs = 300000,
  extraBody = {},
  signal: clientSignal,
  onToken,
}) {
  const startedAt = Date.now();
  let firstChunkAt = null;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = anyAbortSignal([clientSignal, timeoutController.signal]);

  try {
    const text = await streamOpenAiChat({
      endpoint,
      apiKey,
      model: modelId,
      messages: buildMessages({ systemPrompt, prompt }),
      temperature,
      maxTokens,
      extraBody,
      signal,
      onChunk: (chunk, kind = 'content') => {
        if (!firstChunkAt && chunk) firstChunkAt = Date.now();
        if (chunk) return onToken?.(chunk, kind);
        return undefined;
      },
    }).finally(() => clearTimeout(timeoutHandle));
    return {
      backend: runtime,
      modelId,
      endpoint,
      text,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt: Date.now(), text }),
      options: { temperature, maxTokens, timeoutMs },
    };
  } catch (err) {
    clearTimeout(timeoutHandle);
    const error = err?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err?.message || 'Local LLM test failed';
    const partialText = typeof err?.partialOutput === 'string' ? err.partialOutput : '';
    return {
      backend: runtime,
      modelId,
      endpoint,
      error,
      text: partialText,
      timings: summarizeTimings({ startedAt, firstChunkAt, endedAt: Date.now(), text: partialText }),
      options: { temperature, maxTokens, timeoutMs },
    };
  }
}

export async function compareLocalLlmModels({ targets, prompt, mode = 'round-robin', options = {}, signal }) {
  const runOne = (target) => runLocalLlmTest({ ...options, ...target, prompt, signal });
  const results = [];

  if (mode === 'parallel') {
    return {
      mode,
      prompt,
      results: await Promise.all(targets.map(runOne)),
    };
  }

  for (const target of targets) {
    // `runLocalLlmTest` swallows aborts into a result object rather than throwing,
    // so without this guard a cancel mid-sequence would still kick off every
    // remaining model. Stop the round-robin once the client has hung up.
    if (signal?.aborted) break;
    results.push(await runOne(target));
  }
  return { mode: 'round-robin', prompt, results };
}

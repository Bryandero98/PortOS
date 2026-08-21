/**
 * One streaming `POST {base}/chat/completions` against an OpenAI-compatible
 * endpoint.
 *
 * Sibling of `openAiModelsProbe.js`: that module answers "is anything serving
 * here, and what does it serve?", this one answers "generate against it and tell
 * me what streamed". Both exist because PortOS talks to five local daemons
 * (llama.cpp, Ollama, LM Studio, MTPLX, vLLM) that share exactly one wire
 * protocol and nothing else.
 *
 * Two callers, deliberately:
 *   - `services/localLlmPlayground.js` — a provider-backed run with a `/runs`
 *     record, for the backends PortOS configures as providers.
 *   - `services/localModelAssessments.js` — a measurement against a bare
 *     loopback daemon that has no provider record at all.
 *
 * Keeping the SSE read loop here means the reasoning-channel handling, the
 * skip-a-malformed-frame rule, and the partial-output-on-abort behavior are one
 * decision rather than two copies that drift.
 */

import { readResponseJson } from './readResponseJson.js';

/**
 * Parse one OpenAI-style SSE `data:` line into its content/reasoning delta.
 * Returns null for non-data lines, the `[DONE]`/`✅` sentinels, or a malformed
 * frame: a single bad frame must SKIP, not abort the stream — one non-JSON
 * keep-alive would otherwise throw out of the read loop and discard every
 * token already received.
 */
export function extractStreamDelta(rawLine) {
  const line = rawLine.trim();
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (!data || data === '[DONE]' || data === '✅') return null;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const delta = parsed?.choices?.[0]?.delta;
  return { content: delta?.content || '', reasoning: delta?.reasoning || '' };
}

/**
 * Resolve the text to surface from a (possibly interrupted) stream: prefer the
 * visible content, fall back to reasoning when no content arrived (some models
 * emit only a reasoning channel), and `''` when neither did. Used on both the
 * normal-finish path and the partial-output-on-throw path so a timed-out run
 * still shows what streamed before the abort.
 */
export function resolvePartialOutput({ output = '', reasoning = '' }) {
  if (output.trim()) return output;
  if (reasoning.trim()) return reasoning;
  return '';
}

export function buildMessages({ systemPrompt, prompt }) {
  const system = String(systemPrompt || '').trim();
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    { role: 'user', content: prompt },
  ];
}

/**
 * Stream a chat completion and return the final text.
 *
 * @param {object} options
 * @param {string} options.endpoint OpenAI-compatible base ending in `/v1`
 * @param {string} [options.apiKey] attached as a bearer token when set
 * @param {string} options.model
 * @param {Array<{role:string,content:string}>} options.messages
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {object} [options.extraBody] merged into the request body — how a
 *   caller passes a backend-specific knob (Ollama's `num_ctx`) without this
 *   module growing a per-backend branch.
 * @param {AbortSignal} [options.signal]
 * @param {(chunk: string, kind: 'content'|'reasoning') => any} [options.onChunk]
 *   awaited, so a consumer's backpressure reaches the upstream read loop.
 * @returns {Promise<string>} the streamed text. Throws on transport/HTTP
 *   failure; an abort mid-stream throws with `.partialOutput` carrying whatever
 *   had already streamed.
 */
export async function streamOpenAiChat({
  endpoint,
  apiKey,
  model,
  messages,
  temperature,
  maxTokens,
  extraBody = {},
  signal,
  onChunk,
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${String(endpoint || '').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature,
      max_tokens: maxTokens,
      ...extraBody,
    }),
  }).catch((err) => ({ ok: false, status: 0, error: err.message }));

  if (!response.ok) {
    const body = response.text ? await response.text().catch(() => '') : response.error || '';
    throw new Error(`Provider returned ${response.status || 0}: ${body || response.error || response.statusText || 'request failed'}`);
  }

  if (!response.body?.getReader) {
    // A non-streaming 200 (some daemons ignore `stream: true`). Read it whole
    // rather than reporting an empty generation, which a caller would persist as
    // a successful run that produced nothing — hence the `null` sentinel on both
    // a blank and an unparseable body, which throws rather than returning ''.
    const data = await readResponseJson(response, { fallback: null, emptyValue: null });
    if (!data) throw new Error(`Provider returned a non-JSON response (${response.status})`);
    const text = data.choices?.[0]?.message?.content || '';
    if (text) await onChunk?.(text, 'content');
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let reasoning = '';

  const consumeLine = async (rawLine) => {
    const delta = extractStreamDelta(rawLine);
    if (!delta) return;
    if (delta.content) {
      output += delta.content;
      await onChunk?.(delta.content, 'content');
    }
    // Reasoning streams on its own channel so a reasoning-only model
    // (deepseek-r1, qwq, …) renders as it arrives instead of sitting on
    // "waiting for the first token", and so the final content-only text does
    // not inherit reasoning prose.
    if (delta.reasoning) {
      reasoning += delta.reasoning;
      await onChunk?.(delta.reasoning, 'reasoning');
    }
  };

  // Always release the reader (and tear down the socket) on every exit path — a
  // normal finish, an abort via a timeout signal, or a throw mid-stream. On a
  // throw, surface the tokens already streamed (attached to the error) instead
  // of discarding them.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) await consumeLine(line);
    }
    if (buffer.trim()) await consumeLine(buffer);
  } catch (err) {
    err.partialOutput = resolvePartialOutput({ output, reasoning });
    throw err;
  } finally {
    await reader.cancel().catch(() => {});
  }

  return resolvePartialOutput({ output, reasoning });
}

/**
 * One `GET {base}/models` reachability+listing probe for the local
 * OpenAI-compatible daemons (llama.cpp, Ollama, LM Studio, MTPLX).
 *
 * This existed three times in `server/` before it existed once here, and the
 * copies had already drifted: `llamaServerManager`'s passed its timeout as a
 * `timeout` key INSIDE the fetch init object, where it is not an option, so
 * that probe silently ran on the 15s default inside a 500ms startup poll loop.
 * A single implementation makes the timeout, the URL normalization, and the
 * "reachable but unlistable" distinction one decision instead of N.
 *
 * Answers three states a caller must be able to tell apart:
 *   - `reachable: false`             — nothing is serving here (with `error` naming why)
 *   - `reachable: true, models: null`— it answered, but the listing was unreadable
 *   - `reachable: true, models: []`  — it is up and genuinely serving nothing
 */

import { fetchWithTimeout } from './fetchWithTimeout.js';
import { describeFetchError } from './fetchErrorChain.js';
import { readResponseJson } from './readResponseJson.js';

/**
 * The one-token reason a probe failed, for a UI that has a line to spend on it.
 * `describeFetchError` returns the whole cause chain (`fetch failed: ECONNREFUSED:
 * connect ECONNREFUSED <host>:<port>`); the code alone is what tells the user
 * "nothing is listening" from "the host is wedged", and the two timeout
 * spellings mean the same thing to them.
 */
function shortFailureReason(err) {
  // `describeFetchError` walks `.code`/`.message` only, and an abort carries its
  // identity in `.name` (`AbortError`) — which is exactly the timeout case.
  const chain = `${err?.name || ''}: ${describeFetchError(err)}`;
  if (/AbortError|TimeoutError|ETIMEDOUT|UND_ERR_(?:CONNECT_)?TIMEOUT/.test(chain)) return 'timed out';
  const code = chain.match(/\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+)\b/);
  return code ? code[1] : chain.slice(0, 120);
}

/**
 * @param {string} baseUrl - an OpenAI-compatible base (…/v1); trailing slashes tolerated
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{reachable:boolean, models:string[]|null, error:string|null}>}
 */
export async function probeOpenAiModels(baseUrl, { timeoutMs = 2_000 } = {}) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
  const res = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs)
    // undici reports every network failure as a bare `TypeError: fetch failed`;
    // the real reason (ECONNREFUSED vs. ETIMEDOUT — "nothing is listening" vs.
    // "the host is wedged", two different fixes for the user) lives in the
    // cause chain.
    .catch((err) => ({ transportError: shortFailureReason(err) }));

  if (res.transportError) return { reachable: false, models: null, error: res.transportError };
  if (!res.ok) {
    // Undici holds the socket until an unread body is consumed; an endpoint
    // answering 404 on every poll would otherwise leak one each time.
    await res.body?.cancel().catch(() => {});
    return { reachable: false, models: null, error: `HTTP ${res.status}` };
  }

  // The body read is its own failure path: a daemon that accepts the connection
  // and then drops it (or sends a truncated body) rejects inside `res.text()`,
  // NOT at the fetch above. Unhandled, that rejection escapes the probe and
  // fails the entire readiness request — one flaky daemon would blank the
  // checklist for every provider — so it lands on the same
  // reachable-but-unreadable sentinel as a non-JSON body.
  const body = await readResponseJson(res, { fallback: null, emptyValue: null }).catch(() => null);
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (!rows) return { reachable: true, models: null, error: 'model listing was not readable' };
  return {
    reachable: true,
    models: rows
      .map((row) => (typeof row === 'string' ? row : row?.id || row?.name))
      .filter((id) => typeof id === 'string' && id !== ''),
    error: null,
  };
}

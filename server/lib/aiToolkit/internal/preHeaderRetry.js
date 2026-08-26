const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const REPLAY_SAFE_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isTransientGatewayStatus(status) {
  return TRANSIENT_GATEWAY_STATUSES.has(Number(status));
}

export function isReplaySafeTransportError(error) {
  const code = error?.code || error?.cause?.code;
  return REPLAY_SAFE_TRANSPORT_CODES.has(code);
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry a streaming request only while it is still safe to replace the whole
 * response: before the caller has accepted an OK response and begun reading
 * its body. Final responses/errors are returned unchanged so existing provider
 * classification and fallback behavior remain authoritative.
 */
export async function fetchWithPreHeaderRetry(fetchAttempt, {
  signal,
  maxAttempts = 3,
  maxElapsedMs = 2000,
  baseDelayMs = 100,
  now = Date.now,
  delay = abortableDelay,
} = {}) {
  const startedAt = now();

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchAttempt();
      const retryable = isTransientGatewayStatus(response?.status);
      // An OK/non-retryable response is now the caller's stream to consume.
      // Return it even if the signal raced with header delivery: the caller's
      // reader owns partial-output handling from this boundary onward.
      if (!retryable) return response;
      if (signal?.aborted) throw abortError(signal);
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      const hasBudget = attempt < maxAttempts && now() - startedAt + delayMs <= maxElapsedMs;
      if (!hasBudget) return response;

      await Promise.resolve(response.body?.cancel?.()).catch(() => {});
      await delay(delayMs, signal);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      const hasBudget = attempt < maxAttempts && now() - startedAt + delayMs <= maxElapsedMs;
      if (!isReplaySafeTransportError(error) || !hasBudget) throw error;
      await delay(delayMs, signal);
    }
  }
}

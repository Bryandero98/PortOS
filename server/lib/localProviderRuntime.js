/**
 * Which local runtime a provider talks to, and at which endpoint.
 *
 * A provider like `opencode-llama-tui` is only half a configuration: PortOS can
 * spawn the OpenCode CLI perfectly and the run still dies with "Cannot connect
 * to API: Unable to connect" because the daemon it points at — `llama-server`,
 * the Ollama daemon, LM Studio's server, an MTPLX process — was never installed
 * or never started. The binary check in `providerRuntimeInstaller.js` answers
 * "can PortOS run `opencode`?", which is a different question and stays green in
 * exactly that failure.
 *
 * This module is the pure half of the answer: given a provider record, which
 * local runtime backs it (`llama` / `ollama` / `lmstudio` / `mtplx`) and what
 * base URL should be probed. `services/providerReadiness.js` does the probing.
 * Kept side-effect-free so both the readiness service and its tests can reason
 * about the mapping without a daemon on the host.
 *
 * Endpoint resolution deliberately prefers the provider's OWN configuration
 * over the canonical default: a user who moved llama-server to port 8090 edited
 * `OPENCODE_CONFIG_CONTENT` (or `endpoint`), and probing 8080 anyway would
 * report their working setup as broken.
 */

import { getOpencodeLocalProviderNamespace, isOpencodeCommand } from './providerModels.js';

/**
 * One row per local runtime PortOS knows how to check for.
 *
 * `manageUrl` is the client route that installs/starts it — the Local LLM
 * settings tab owns every one of these flows, so an unmet requirement links
 * there rather than duplicating the install UI on the Providers page.
 */
export const LOCAL_RUNTIMES = Object.freeze({
  llama: Object.freeze({
    id: 'llama',
    label: 'llama.cpp',
    // The server binary, not the `llama` convenience wrapper: this is what
    // `llamaServerManager` resolves and starts.
    command: 'llama-server',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    manageUrl: '/settings/local-llm',
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
    // Named so an unmet check can say what the user still has to fetch. GGUF
    // weights are a separate download from the binary — the single most common
    // reason a freshly-installed llama.cpp still cannot serve a request.
    modelsHint: 'llama.cpp serves GGUF weights you download yourself — a base model, plus a drafter for speculative decoding.',
  }),
  ollama: Object.freeze({
    id: 'ollama',
    label: 'Ollama',
    command: 'ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    manageUrl: '/settings/local-llm',
    docsUrl: 'https://ollama.com/download',
    modelsHint: 'Pull a model from Settings → Local LLM before an agent can use this provider.',
  }),
  lmstudio: Object.freeze({
    id: 'lmstudio',
    label: 'LM Studio',
    command: 'lms',
    defaultBaseUrl: 'http://localhost:1234/v1',
    manageUrl: '/settings/local-llm',
    docsUrl: 'https://lmstudio.ai/download',
    modelsHint: 'Download a model in LM Studio and start its local server.',
  }),
  mtplx: Object.freeze({
    id: 'mtplx',
    label: 'MTPLX',
    // PortOS ships no installer for MTPLX — it is a user-run process — so the
    // readiness report offers docs instead of an install action.
    command: null,
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    manageUrl: null,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/mtplx.md',
    modelsHint: 'Start the MTPLX server yourself; PortOS does not manage that process.',
  }),
});

/** Normalize a base URL to the `/v1` root an OpenAI-compatible probe needs. */
export function normalizeOpenAiBaseUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** The `baseURL` an OpenCode provider config declares for `namespace`, if any. */
function opencodeConfiguredBaseUrl(provider, namespace) {
  const stored = provider?.envVars?.OPENCODE_CONFIG_CONTENT;
  if (typeof stored !== 'string' || stored === '') return null;
  let parsed = null;
  try {
    parsed = JSON.parse(stored);
  } catch {
    // A hand-edited config that no longer parses tells us nothing about the
    // endpoint; fall through to the provider's own fields.
    return null;
  }
  const baseUrl = parsed?.provider?.[namespace]?.options?.baseURL;
  return typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl : null;
}

/**
 * The local-runtime kind a provider is backed by, from its explicit markers
 * first and its endpoint/name only as a fallback.
 *
 * The `*Backed` markers are authoritative — they are what the spawner itself
 * keys on. The heuristic tail mirrors the client's `localBackendForProvider`
 * so a plain `api` provider pointed at Ollama or LM Studio is recognized too.
 *
 * `orcarouter` is deliberately excluded: it is an OpenCode local *namespace*
 * but a remote hosted API, so there is no local daemon to check.
 *
 * @param {object|null|undefined} provider
 * @returns {'llama'|'ollama'|'lmstudio'|'mtplx'|null}
 */
export function localRuntimeKind(provider) {
  if (!provider || typeof provider !== 'object') return null;

  const namespace = getOpencodeLocalProviderNamespace(provider);
  if (namespace && namespace !== 'orcarouter') return namespace;
  // `claude-ollama` carries `ollamaBacked` without being an OpenCode provider.
  if (provider.ollamaBacked === true) return 'ollama';

  const endpoint = String(provider.endpoint || '');
  const id = String(provider.id || '').toLowerCase();
  const name = String(provider.name || '').toLowerCase();
  if (id === 'ollama' || /:11434\b/.test(endpoint) || name.includes('ollama')) return 'ollama';
  if (id === 'lmstudio' || /:1234\b/.test(endpoint) || /lm[\s-]?studio/.test(name)) return 'lmstudio';
  return null;
}

/**
 * The local runtime a provider needs, with the endpoint PortOS should probe.
 *
 * @param {object|null|undefined} provider
 * @returns {{kind:string,label:string,command:string|null,endpoint:string|null,manageUrl:string|null,docsUrl:string,modelsHint:string}|null}
 */
export function localRuntimeForProvider(provider) {
  const kind = localRuntimeKind(provider);
  if (!kind) return null;
  const runtime = LOCAL_RUNTIMES[kind];

  const configured = isOpencodeCommand(provider?.command)
    ? opencodeConfiguredBaseUrl(provider, kind)
    // Claude's Ollama wrapper carries the daemon URL in its own env var.
    : (typeof provider?.envVars?.ANTHROPIC_BASE_URL === 'string' ? provider.envVars.ANTHROPIC_BASE_URL : null);

  const endpoint = normalizeOpenAiBaseUrl(configured)
    || normalizeOpenAiBaseUrl(provider?.endpoint)
    || runtime.defaultBaseUrl;

  return {
    kind: runtime.id,
    label: runtime.label,
    command: runtime.command,
    endpoint,
    manageUrl: runtime.manageUrl,
    docsUrl: runtime.docsUrl,
    modelsHint: runtime.modelsHint,
  };
}

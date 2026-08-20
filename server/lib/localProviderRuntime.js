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
 * `localBackendForProvider` (and the loopback-host rules under it) lived in
 * `services/localModelHealing.js` until this module existed; it moved here so
 * the healing path and the readiness path classify a provider identically, and
 * `localModelHealing.js` re-exports it for its existing callers.
 *
 * Endpoint resolution deliberately prefers the provider's OWN configuration
 * over any default: a user who moved llama-server to port 8090 edited
 * `OPENCODE_CONFIG_CONTENT` (or `endpoint`), and probing 8080 anyway would
 * report their working setup as broken.
 */

import { getOpencodeLocalProviderNamespace, isOpencodeCommand } from './providerModels.js';
import { opencodeLocalBaseUrl } from './opencodeConfig.js';

// Default OpenAI-compatible ports for the two local backends PortOS manages. An
// endpoint-only provider (no id/name) pointed at one of these on the local
// instance maps to that backend.
const BACKEND_DEFAULT_PORT = { 11434: 'ollama', 1234: 'lmstudio' };

/**
 * True when a hostname names the SAME local instance the backend manager runs
 * on — any loopback (`127.0.0.0/8`, `::1`), `localhost`, or the unspecified /
 * bind-all address (`0.0.0.0`, `::`, which a manager bound to all interfaces
 * reports while a provider reaches it as localhost). These all canonicalize to
 * one token so spelling differences don't block healing. Deliberately NOT
 * link-local / LAN / Tailscale hosts — a peer on another box is a DIFFERENT
 * instance whose installed models we must not heal against, and whose daemon
 * PortOS must not offer to install here.
 */
export function isLocalInstanceHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  return h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Parse a provider endpoint (with any `/v1` suffix stripped) into a URL, or null. */
function parseEndpoint(endpoint) {
  const cleaned = String(endpoint || '').replace(/\/v\d+\/?$/, '').replace(/\/+$/, '');
  try {
    return new URL(cleaned);
  } catch { return null; }
}

/**
 * Does this endpoint point at a daemon running on THIS machine?
 *
 * The distinction decides whether PortOS may inspect the host it is running on
 * to explain the endpoint. An endpoint on a LAN/tailnet box is an EXTERNAL API
 * server: whether `lms` is on this machine's PATH, or this machine's LM Studio
 * app is installed, says nothing about it — so those checks must not run, and
 * their answers must never be reported as that provider's requirements.
 *
 * An unparseable/blank endpoint is NOT local: callers resolve their own local
 * default before asking, so anything still unparseable here is a typo, and
 * guessing "local" would put this machine's install state on a remote card.
 */
export function isLocalInstanceEndpoint(endpoint) {
  const url = parseEndpoint(endpoint);
  return url ? isLocalInstanceHost(url.hostname) : false;
}

/**
 * The port of a provider endpoint when it points at THIS machine's local
 * instance (any loopback / bind-all host spelling); null otherwise — so a
 * LAN/Tailscale peer on the same port is NOT mistaken for a local backend.
 */
export function localEndpointPort(endpoint) {
  const u = parseEndpoint(endpoint);
  if (!u || !isLocalInstanceHost(u.hostname)) return null;
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

// MIRROR of `isOllamaProvider` in services/ollamaManager.js — keep in lockstep.
// Inlined so this module stays free of the manager's module graph.
const isOllamaShape = (provider) =>
  provider?.id === 'ollama' ||
  /ollama/i.test(provider?.name || '') ||
  /(^|[/:])(?:localhost|127\.0\.0\.1|\[::1\]):11434\b/i.test(String(provider?.endpoint || ''));

/**
 * Which local backend (if any) a provider maps to. Matches by id/name first
 * (`ollama` / `lmstudio`), then by an endpoint pointing at the backend's default
 * port on THIS machine's local instance.
 * @returns {'ollama'|'lmstudio'|null}
 */
export function localBackendForProvider(provider) {
  if (isOllamaShape(provider)) return 'ollama';
  if (provider?.id === 'lmstudio' || /lm[\s-]?studio/i.test(provider?.name || '')) return 'lmstudio';
  const port = localEndpointPort(provider?.endpoint);
  return port ? (BACKEND_DEFAULT_PORT[port] || null) : null;
}

/**
 * One row per local runtime PortOS knows how to check for.
 *
 * `defaultBaseUrl` is read from `opencodeConfig.js`'s provider table rather than
 * re-typed: that table is what a spawned OpenCode actually talks to when the
 * provider stores no config of its own, so a second copy here would eventually
 * probe a port nothing is on and call a working setup broken. LM Studio has no
 * row there (nothing spawns OpenCode against it), so it carries its own.
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
    defaultBaseUrl: opencodeLocalBaseUrl('llama'),
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
    defaultBaseUrl: opencodeLocalBaseUrl('ollama'),
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
    command: 'mtplx',
    defaultBaseUrl: opencodeLocalBaseUrl('mtplx'),
    // No Local LLM tab entry — MTPLX has no model catalog inside PortOS. The
    // one-click setup on the readiness checklist
    // (`services/localRuntimeSetup.js`) is what installs and starts it.
    manageUrl: null,
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/features/mtplx.md',
    modelsHint: 'Point the server at the Qwen MTP checkpoint you want; PortOS does not download weights.',
  }),
});

/**
 * Normalize a base URL to the `/v1` root an OpenAI-compatible probe needs.
 * A scheme is added when missing, because `OLLAMA_HOST` is conventionally a
 * bare `host:port` (mirroring `ollamaManager`'s own normalization).
 */
export function normalizeOpenAiBaseUrl(url) {
  if (typeof url !== 'string') return null;
  let trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `http://${trimmed}`;
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * The base URL the rest of PortOS talks to this backend on, when the provider
 * itself names none. The backend managers resolve their own base URL from these
 * env vars (`ollamaManager.js`, `lmStudioManager.js`); reading them here keeps a
 * relocated daemon from showing up as "not responding — install it" on the card
 * while every other PortOS feature reaches it fine.
 */
function envBaseUrl(kind) {
  if (kind === 'ollama') return process.env.OLLAMA_URL || process.env.OLLAMA_HOST || null;
  if (kind === 'lmstudio') return process.env.LM_STUDIO_URL || null;
  return null;
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
 * keys on. `orcarouter` is deliberately excluded: it is an OpenCode local
 * *namespace* but a remote hosted API, so there is no local daemon to check.
 *
 * @param {object|null|undefined} provider
 * @returns {'llama'|'ollama'|'lmstudio'|'mtplx'|null}
 */
export function localRuntimeKind(provider) {
  if (!provider || typeof provider !== 'object') return null;
  // Marker-based, NOT command-based: this also resolves `claude-ollama`, which
  // carries `ollamaBacked` without being an OpenCode provider.
  const namespace = getOpencodeLocalProviderNamespace(provider);
  if (namespace && namespace !== 'orcarouter') return namespace;
  return localBackendForProvider(provider);
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
    || normalizeOpenAiBaseUrl(envBaseUrl(kind))
    || runtime.defaultBaseUrl;

  // A provider whose endpoint lives on ANOTHER machine has no local runtime,
  // however local its name/id looks. An `LM Studio <box>` provider pointed
  // at a LAN host still matched `lmstudio` by NAME, and the card answered
  // "LM Studio installed — `lms` is on PortOS's PATH" and "start it from
  // Settings → Local LLM" about a server PortOS neither runs nor can start.
  // An external API endpoint is assumed to be set up by whoever runs it; the
  // only honest report here is none.
  if (!isLocalInstanceEndpoint(endpoint)) return null;

  const { id, ...row } = runtime;
  return { ...row, kind: id, endpoint };
}

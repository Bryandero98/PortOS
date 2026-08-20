/**
 * "Is everything this provider needs actually installed and running?"
 *
 * The Providers page could already tell you whether the CLI binary a provider
 * shells out to exists (`providerRuntimeInstaller.js`). For a provider backed by
 * a LOCAL daemon that is only half the story: `opencode` can be perfectly
 * installed and the run still ends at
 *
 *     Cannot connect to API: Unable to connect. Is the computer able to access the url
 *
 * because `llama-server` was never installed, or was installed but never
 * started, or is running but serving a different model alias than the provider
 * asks for. Those are three distinct fixes, and none of them was visible from
 * the provider card — the user had to read a failed agent transcript to learn
 * that a second piece of software (and a multi-gigabyte model download) was
 * still missing.
 *
 * This module turns that into a per-provider requirements checklist:
 *
 *   1. runtime  — the daemon's binary is on PortOS's PATH (or something is
 *                 already answering, which proves it another way)
 *   2. server   — the endpoint the provider points at answers `GET /v1/models`
 *   3. model    — the provider's default model is one the endpoint serves
 *
 * Checks are reported in fix order, each with what to do about it. Only
 * local-daemon providers get a report at all (`localProviderRuntime.js` decides
 * which those are); everything else returns `null` and renders nothing.
 *
 * No LLM call is ever made here — `GET /v1/models` is a listing, so this is safe
 * to poll from a settings page under the no-cold-bootstrap policy in CLAUDE.md.
 */

import { LOCAL_RUNTIMES, localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { isConfiguredDefaultModel } from '../lib/providerModels.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { findCommandOnPath } from '../lib/processEnv.js';

/**
 * Loopback daemons answer (or refuse the connection) in single-digit
 * milliseconds, so a short bound keeps a page poll snappy. A host that needs
 * longer than this to answer a model listing is not going to serve an agent run
 * either, and reporting it as unreachable points at the right fix.
 */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Collapse the bursts a page reload produces (the Providers page asks for
 * readiness on mount and on every 20s status poll, and several providers can
 * share one endpoint) without going stale enough to hide a daemon the user just
 * started from the Local LLM tab.
 */
const PROBE_TTL_MS = 5_000;

// endpoint → { at, result }
const probeCache = new Map();

/**
 * Ask an OpenAI-compatible endpoint what it serves.
 * @returns {Promise<{reachable:boolean, models:string[]|null, error:string|null}>}
 *   `models: null` means reachable but the listing could not be read — distinct
 *   from `[]`, a server that is up with nothing loaded.
 */
async function probeEndpoint(endpoint) {
  const res = await fetchWithTimeout(`${endpoint}/models`, { method: 'GET' }, PROBE_TIMEOUT_MS)
    .catch((err) => ({ ok: false, transportError: err?.message || 'connection failed' }));

  if (res.transportError) return { reachable: false, models: null, error: res.transportError };
  if (!res.ok) return { reachable: false, models: null, error: `HTTP ${res.status}` };

  const body = await res.json().catch(() => null);
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (!rows) return { reachable: true, models: null, error: 'model listing was not readable' };
  const models = rows
    .map((row) => (typeof row === 'string' ? row : row?.id || row?.name))
    .filter((id) => typeof id === 'string' && id !== '');
  return { reachable: true, models, error: null };
}

/** Cached endpoint probe — see PROBE_TTL_MS. */
async function probeEndpointCached(endpoint, probe) {
  const cached = probeCache.get(endpoint);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result;
  const result = await probe(endpoint);
  probeCache.set(endpoint, { at: Date.now(), result });
  return result;
}

/**
 * The model id the endpoint would be asked for: the provider's default with any
 * OpenCode `<namespace>/` prefix stripped, since that prefix addresses the
 * OpenCode provider entry and never reaches the daemon's own model list.
 * Returns null when the provider selects no specific model.
 */
function servedModelId(provider, kind) {
  const model = provider?.defaultModel;
  if (typeof model !== 'string' || model.trim() === '' || isConfiguredDefaultModel(model)) return null;
  const trimmed = model.trim();
  return trimmed.startsWith(`${kind}/`) ? trimmed.slice(kind.length + 1) : trimmed;
}

/**
 * The requirements checklist for one provider, or `null` when the provider does
 * not depend on a local daemon.
 *
 * Deps are injectable so the suite can drive every combination without a daemon
 * or a real PATH on the host.
 *
 * @param {object} provider - the RAW provider record (endpoint + envVars intact;
 *   a sanitized copy has its secret env values redacted, which would hide a
 *   custom base URL)
 * @param {{findCommand?:Function, probe?:Function}} [deps]
 */
export async function getProviderReadiness(provider, deps = {}) {
  const runtime = localRuntimeForProvider(provider);
  if (!runtime) return null;

  const findCommand = deps.findCommand || findCommandOnPath;

  // An injected probe bypasses the cache: it is a different oracle than the
  // real one, and sharing a cache entry with it would let one caller's stub
  // answer for another's live probe.
  const endpointResult = deps.probe
    ? await deps.probe(runtime.endpoint)
    : await probeEndpointCached(runtime.endpoint, probeEndpoint);
  // A daemon that answers is installed, whatever PATH says — Ollama's macOS app
  // and LM Studio both serve without putting a CLI on PortOS's PATH.
  const onPath = Boolean(runtime.command && findCommand(runtime.command));
  const installed = onPath || endpointResult.reachable;

  const checks = [];

  checks.push({
    id: 'runtime',
    label: `${runtime.label} installed`,
    ok: installed,
    detail: installed
      ? (onPath ? `\`${runtime.command}\` is on PortOS's PATH.` : `Something is already serving ${runtime.endpoint}.`)
      : runtime.command
        ? `\`${runtime.command}\` was not found on PortOS's PATH.`
        : `PortOS does not install ${runtime.label} — start it yourself.`,
    fixHint: installed
      ? null
      : runtime.manageUrl
        ? `Install ${runtime.label} from Settings → Local LLM.`
        : `Follow the ${runtime.label} setup docs, then reload this page.`,
  });

  checks.push({
    id: 'server',
    label: `${runtime.label} server responding`,
    ok: endpointResult.reachable,
    detail: endpointResult.reachable
      ? `${runtime.endpoint} answered.`
      : `Nothing answered at ${runtime.endpoint}${endpointResult.error ? ` (${endpointResult.error})` : ''}.`,
    fixHint: endpointResult.reachable
      ? null
      : installed
        ? `Start ${runtime.label}${runtime.manageUrl ? ' from Settings → Local LLM' : ''}. ${runtime.modelsHint}`
        : `Install ${runtime.label} first, then start it. ${runtime.modelsHint}`,
  });

  const wantedModel = servedModelId(provider, runtime.kind);
  if (wantedModel) {
    // Only assertable against a server that answered with a readable list. An
    // unreachable (or unlistable) endpoint says nothing about the model, and
    // reporting it as missing would send the user after the wrong fix.
    const served = endpointResult.reachable ? endpointResult.models : null;
    const ok = Array.isArray(served) ? served.includes(wantedModel) : null;
    checks.push({
      id: 'model',
      label: `Model \`${wantedModel}\` available`,
      ok,
      detail: ok === null
        ? 'Cannot be checked until the server responds.'
        : ok
          ? `${runtime.label} is serving \`${wantedModel}\`.`
          : served.length === 0
            ? `${runtime.label} is running but has no model loaded.`
            : `${runtime.label} is serving ${served.slice(0, 3).map((id) => `\`${id}\``).join(', ')}${served.length > 3 ? ` +${served.length - 3} more` : ''}.`,
      fixHint: ok === null || ok
        ? null
        : `${runtime.modelsHint} Then set this provider's default model to one the server reports.`,
    });
  }

  return {
    kind: runtime.kind,
    label: runtime.label,
    endpoint: runtime.endpoint,
    manageUrl: runtime.manageUrl,
    docsUrl: runtime.docsUrl,
    // `ready` is strict: a check that could not be evaluated (`ok: null`) is not
    // a pass, so the card never claims a provider is good to go on unknowns.
    ready: checks.every((check) => check.ok === true),
    checks,
  };
}

/**
 * Readiness for every provider that needs a local daemon, keyed by provider id.
 * Providers with no local dependency are omitted entirely, so the client can
 * treat "absent" as "nothing to report".
 *
 * @param {object[]} providers - RAW provider records
 */
export async function getProviderReadinessMap(providers, deps = {}) {
  const list = Array.isArray(providers) ? providers : [];
  // One PATH scan per distinct binary, and one HTTP probe per distinct endpoint,
  // no matter how many providers share them.
  const pathCache = new Map();
  const findCommand = deps.findCommand || findCommandOnPath;
  const memoFind = (command) => {
    if (!pathCache.has(command)) pathCache.set(command, findCommand(command));
    return pathCache.get(command);
  };

  const entries = await Promise.all(list.map(async (provider) => {
    const readiness = await getProviderReadiness(provider, { ...deps, findCommand: memoFind });
    return readiness ? [provider.id, readiness] : null;
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

/** The runtimes this module knows how to check — re-exported for callers/tests. */
export { LOCAL_RUNTIMES };

/** Drops the endpoint probe cache (tests, and after an install/start action). */
export function resetProviderReadinessCache() {
  probeCache.clear();
}

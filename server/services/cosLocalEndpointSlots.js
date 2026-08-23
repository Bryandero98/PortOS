/**
 * CoS local-inference agent slots (issue #4834)
 *
 * `promptRunner`'s `withLocalConcurrencyGate` caps concurrent IN-FLIGHT calls
 * per local endpoint, but it only sees requests PortOS itself makes. A CoS TUI
 * agent runs a vendor CLI that opens its own connection to the local model
 * server — PortOS never observes that traffic, so `dequeueNextTask` could
 * dispatch two or three agents at one GPU and push it into an accelerator OOM.
 *
 * This module supplies the *avoidance* half: the per-cycle lookups the spawn
 * scheduler needs to count running agents per local endpoint and to predict
 * which endpoint a queued task would land on. The gate itself is enforced by
 * the pure capacity tracker in cosDequeue.js.
 *
 * Deliberately separate accounting from promptRunner's in-process gate: one
 * throttles requests PortOS makes, the other throttles agents PortOS launches.
 * A shared counter across process boundaries isn't worth the coupling.
 */

import { isLocalEndpoint, LOCAL_LLM_MAX_CONCURRENCY } from '../lib/promptRunner.js';
import { listProviders, getActiveProvider } from './providers.js';

// One knob governs both paths — no new config key. A local box beefy enough to
// hold N model contexts lifts LOCAL_LLM_MAX_CONCURRENCY and gets N agent slots
// along with N in-flight API calls.
export const LOCAL_ENDPOINT_AGENT_LIMIT = LOCAL_LLM_MAX_CONCURRENCY;

/**
 * The local endpoint a provider runs against, or null when it has none.
 *
 * Reads ONLY the endpoint recorded on the provider — never a model-id prefix.
 * A CLI/TUI provider with no recorded endpoint resolves to null and stays
 * ungated, which is the intended behavior: PortOS cannot know where an
 * unconfigured vendor CLI points.
 *
 * Not gated on `provider.type === 'api'` (unlike promptRunner's request gate):
 * a TUI provider pointed at a local LM Studio IS the case this exists for.
 */
export function localEndpointOfProvider(provider) {
  const endpoint = provider?.endpoint;
  return isLocalEndpoint(endpoint) ? endpoint.trim() : null;
}

/**
 * Build the per-cycle local-endpoint lookups from an ALREADY-FETCHED provider
 * snapshot. Pure and synchronous — the capacity tracker consults it per
 * candidate task, and tests drive it with fixtures instead of a live toolkit.
 *
 *  - `endpointForAgent(agent)`  — the endpoint a RUNNING agent is occupying,
 *    from the `providerId` agentLifecycle stamps onto its metadata.
 *  - `resolveLocalEndpoint(task)` — the endpoint a QUEUED task would land on.
 *    Mirrors `resolveAgentProviderAndModel`: a `metadata.provider` pin wins,
 *    and an unknown pin falls back to the active provider exactly as spawn
 *    does. A runtime fallback swap can still move a run to another provider —
 *    this is avoidance, not a guarantee, and promptRunner's gate plus the OOM
 *    nudge/fail-over remain the recovery half.
 */
export function createLocalEndpointSlotContext({ providers = [], activeProvider = null, limit = LOCAL_ENDPOINT_AGENT_LIMIT } = {}) {
  const byId = new Map();
  for (const provider of providers) {
    if (provider?.id) byId.set(provider.id, provider);
  }
  if (activeProvider?.id && !byId.has(activeProvider.id)) byId.set(activeProvider.id, activeProvider);

  const endpointById = (id) => localEndpointOfProvider(byId.get(id));
  const activeEndpoint = localEndpointOfProvider(activeProvider);

  return {
    limit,
    endpointForAgent: (agent) => {
      const providerId = agent?.metadata?.providerId || agent?.providerId;
      return providerId ? endpointById(providerId) : null;
    },
    resolveLocalEndpoint: (task) => {
      const pinnedId = task?.metadata?.provider;
      if (pinnedId) return byId.has(pinnedId) ? endpointById(pinnedId) : activeEndpoint;
      return activeEndpoint;
    },
  };
}

/**
 * Fetch the provider snapshot and build the lookups above.
 *
 * Never throws: `listProviders` already swallows a failed read into `[]`, and
 * an uninitialized toolkit yields a null active provider — which resolves every
 * task to null (ungated) rather than stalling the queue.
 */
export async function buildLocalEndpointSlotContext() {
  const providers = await listProviders();
  const activeProvider = await getActiveProvider().catch(() => null);
  return createLocalEndpointSlotContext({ providers, activeProvider });
}

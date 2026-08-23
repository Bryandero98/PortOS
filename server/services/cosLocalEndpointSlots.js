/**
 * CoS local-inference agent slots (issue #4834)
 *
 * `promptRunner`'s `withLocalConcurrencyGate` caps concurrent IN-FLIGHT calls
 * per local endpoint, but it only sees requests PortOS itself makes. A CoS TUI
 * agent runs a vendor CLI that opens its own connection to the local model
 * server — PortOS never observes that traffic, so `dequeueNextTask` could
 * dispatch two or three agents at one GPU and push it into an accelerator OOM.
 *
 * This module supplies the *avoidance* half, enforced at two altitudes:
 *
 *   - `acquireLocalEndpointSpawnSlot` is the AUTHORITATIVE cap, called from
 *     subAgentSpawner's `task:ready` listener — the one chokepoint every
 *     emitter funnels through. It reserves the slot across the spawn window so
 *     two dispatches can't both read a pre-registration snapshot and pass.
 *   - `createLocalEndpointSlotContext` feeds the pure capacity tracker in
 *     cosDequeue.js, so `dequeueNextTask` simply never emits a task that would
 *     be held — cheaper, and it logs queued-no-slot against the right task.
 *
 * Deliberately separate accounting from promptRunner's in-process gate: one
 * throttles requests PortOS makes, the other throttles agents PortOS launches.
 * A shared counter across process boundaries isn't worth the coupling.
 */

import { isLocalEndpoint, LOCAL_LLM_MAX_CONCURRENCY } from '../lib/promptRunner.js';
import { listProviders, getActiveProvider } from './providers.js';
import { isProviderAvailable } from './providerStatus.js';
import { countRunningAgentsByLocalEndpoint } from './cosDequeue.js';

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
 *    Mirrors `resolveAgentProviderAndModel`: a `metadata.provider` pin wins, an
 *    unknown pin falls back to the active provider, and an UNAVAILABLE provider
 *    resolves to null because spawn will swap it for a fallback (often cloud) —
 *    gating on it would hold the task behind a GPU it is never going to touch,
 *    with nothing to clear the hold. A runtime fallback swap after that point
 *    can still move a run: this is avoidance, not a guarantee, and
 *    promptRunner's gate plus the OOM nudge/fail-over remain the recovery half.
 *
 * `isAvailable` is injected (rather than imported) so this stays pure and a
 * test can drive the real resolver without provider-status module state.
 */
export function createLocalEndpointSlotContext({
  providers = [],
  activeProvider = null,
  limit = LOCAL_ENDPOINT_AGENT_LIMIT,
  isAvailable = () => true,
} = {}) {
  const byId = new Map();
  for (const provider of providers) {
    if (provider?.id) byId.set(provider.id, provider);
  }
  if (activeProvider?.id && !byId.has(activeProvider.id)) byId.set(activeProvider.id, activeProvider);

  const endpointById = (id) => localEndpointOfProvider(byId.get(id));

  // The provider a queued task would be resolved onto, before the availability
  // check below. An unknown pin falls through to the active provider, exactly
  // as `resolveAgentProviderAndModel` does.
  const providerForTask = (task) => {
    const pinnedId = task?.metadata?.provider;
    return (pinnedId && byId.get(pinnedId)) || activeProvider;
  };

  return {
    limit,
    endpointForAgent: (agent) => {
      // The endpoint stamped at spawn wins: it is what this agent's inference
      // ACTUALLY landed on, and it survives the provider record being edited or
      // deleted while the agent is still holding the GPU. Falling back to the id
      // lookup keeps pre-#4834 agent records counted.
      const stamped = localEndpointOfProvider({ endpoint: agent?.metadata?.providerEndpoint });
      if (stamped) return stamped;
      const providerId = agent?.metadata?.providerId || agent?.providerId;
      return providerId ? endpointById(providerId) : null;
    },
    resolveLocalEndpoint: (task) => {
      const provider = providerForTask(task);
      if (!provider?.id) return null;
      // An unavailable provider is NOT where this task lands — spawn swaps it
      // for a fallback. Holding the task at this endpoint anyway would starve
      // it: the fallback it actually wants may be cloud, and nothing about the
      // busy GPU would ever clear the hold.
      if (!isAvailable(provider.id)) return null;
      return localEndpointOfProvider(provider);
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
  return createLocalEndpointSlotContext({ providers, activeProvider, isAvailable: isProviderAvailable });
}

// ── In-flight spawn reservations ───────────────────────────────────────────
// A dispatched task is invisible to `countRunningAgentsByLocalEndpoint` until
// its agent record reaches `running` — a window several awaits wide (provider
// resolution, prompt build, worktree setup, PTY spawn). Two `task:ready`
// dispatches landing inside that window would both read the same snapshot and
// both pass the cap, which is the exact over-dispatch #4834 exists to stop.
//
// So the chokepoint reserves the slot up front and releases it once the spawn
// settles — by which point the agent record carries the load. This is a simple
// in-process re-entrancy guard over one server's own dispatch loop, not a
// defense against competing actors (see the Security Model in CLAUDE.md).
// Mirrors `spawningJobIds` in cosJobScheduler.js, which bridges the same gap.
const pendingSpawnsByEndpoint = new Map();

const NOOP_RELEASE = () => {};

/**
 * Reserve an in-flight spawn slot on `endpoint`. Returns the release function,
 * which is idempotent so a double-release (a throw plus the `finally`) can't
 * drive the count negative and hand out a slot that is still occupied.
 */
export function reserveLocalEndpointSpawn(endpoint) {
  if (!endpoint) return NOOP_RELEASE;
  pendingSpawnsByEndpoint.set(endpoint, (pendingSpawnsByEndpoint.get(endpoint) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pendingSpawnsByEndpoint.get(endpoint) || 1) - 1;
    if (remaining > 0) pendingSpawnsByEndpoint.set(endpoint, remaining);
    else pendingSpawnsByEndpoint.delete(endpoint);
  };
}

/** Spawns dispatched at `endpoint` that have not yet reached `running`. */
export function pendingLocalEndpointSpawns(endpoint) {
  return endpoint ? (pendingSpawnsByEndpoint.get(endpoint) || 0) : 0;
}

/** Test hook — drop every outstanding reservation. */
export function __resetLocalEndpointSpawnReservations() {
  pendingSpawnsByEndpoint.clear();
}

/**
 * Claim a local-endpoint spawn slot for `task`, or report why it must wait.
 *
 * This is the AUTHORITATIVE cap. The scheduler-side check in `dequeueNextTask`
 * only avoids emitting a `task:ready` that would be held anyway; six other
 * emitters (evaluateTasks, forceSpawnTask, cosJobScheduler, the Creative
 * Director bridge, …) reach the spawner without passing through it, so the gate
 * has to live where all of them funnel — subAgentSpawner's `task:ready`
 * listener.
 *
 * `{ ok: true }` with a no-op release when the task has no local endpoint.
 * Callers MUST invoke `release()` in a `finally` once the spawn settles.
 *
 * @param {object} task
 * @param {object} agents - `state.agents`, the running-agent map
 * @returns {Promise<{ ok: true, release: () => void } | { ok: false, reason: string }>}
 */
export async function acquireLocalEndpointSpawnSlot(task, agents) {
  const slots = await buildLocalEndpointSlotContext();
  const endpoint = slots.resolveLocalEndpoint(task);
  if (!endpoint) return { ok: true, release: NOOP_RELEASE };

  const { atCapacity, inFlight, limit } = readEndpointCapacity(endpoint, agents, slots);
  if (atCapacity) {
    return { ok: false, reason: `local endpoint ${endpoint} is at capacity (${inFlight}/${limit})` };
  }
  return { ok: true, release: reserveLocalEndpointSpawn(endpoint) };
}

/** Running agents plus in-flight reservations on `endpoint`, against the cap. */
function readEndpointCapacity(endpoint, agents, slots) {
  const running = countRunningAgentsByLocalEndpoint(agents, slots.endpointForAgent)[endpoint] || 0;
  const inFlight = running + pendingLocalEndpointSpawns(endpoint);
  return { inFlight, limit: slots.limit, atCapacity: inFlight >= slots.limit };
}

/**
 * Why a spawn on the ALREADY-RESOLVED `provider` must wait, or null when it may
 * proceed.
 *
 * `forceSpawnTask` (the user's explicit "Run now") returns synchronously while
 * the spawn happens later in a `task:ready` listener, so without this it would
 * answer `{ success: true }` and toast "Spawning" for a dispatch the chokepoint
 * immediately holds — the same lie the provider-resolution pre-check upstream of
 * it exists to prevent. Takes the post-fallback provider, so it is strictly more
 * accurate than the queued-task prediction in `resolveLocalEndpoint`.
 */
export async function localEndpointCapacityError(provider, agents) {
  const endpoint = localEndpointOfProvider(provider);
  if (!endpoint) return null;
  const slots = await buildLocalEndpointSlotContext();
  const { atCapacity, inFlight, limit } = readEndpointCapacity(endpoint, agents, slots);
  if (!atCapacity) return null;
  return `Local inference endpoint ${endpoint} is at capacity (${inFlight}/${limit}) — wait for a running agent to finish`;
}

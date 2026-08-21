/**
 * Local media-lane capacity — "what is this machine rendering, and can it take
 * another job?" (#4348).
 *
 * Split out of `activeProcessing.js` rather than folded into it: that service
 * answers a live-activity question for the dashboard (it lists every in-flight
 * job, probes GPU *utilization* on a 4s TTL, and reads CoS/Ollama state), while
 * System Health needs only the cheap capacity shape and is polled on a much
 * slower cadence. Sharing the heavier projection would drag nvidia-smi
 * utilization probes and a CoS task read onto every health poll.
 *
 * FEDERATION NOTE: this shape is returned by `GET /api/system/health/details`,
 * which registered peers fetch on every probe. It therefore describes ONLY this
 * machine's own runtime — never our peer list, our routing policy, or the
 * models we have allowlisted on someone else's instance. Consumer-side
 * capacity stays local (see `redactPeerForWire` in services/instances.js), and
 * the provider-side allowlist has its own authenticated endpoint.
 */

import { getCudaCapability } from '../lib/cudaCapability.js';
import { getQueueCapacity } from './mediaJobQueue/index.js';

/**
 * @returns {Promise<{gpu: {cudaStatus: 'available'|'absent'|'unknown', laneBusy: boolean, laneKind: string|null},
 *   lanes: object, byKind: object, totals: {running: number, queued: number}}>}
 */
export async function getMediaCapacity() {
  // Three-state, never a boolean: `unknown` (the probe itself failed) must stay
  // distinct from `absent` (no CUDA device here). A caller that collapses them
  // reports a failed probe as "this machine has no GPU", which is the exact
  // conflation the issue's capacity contract forbids.
  const capability = await getCudaCapability().catch(() => ({ status: 'unknown' }));
  const capacity = getQueueCapacity();
  return {
    gpu: {
      cudaStatus: capability.status,
      laneBusy: capacity.lanes.gpu.running > 0,
      laneKind: capacity.runningKind,
    },
    lanes: capacity.lanes,
    byKind: capacity.byKind,
    totals: capacity.totals,
  };
}

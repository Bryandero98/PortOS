/**
 * Internet-reachability probe.
 *
 * A liveness signal answering "does this machine currently have internet?" —
 * used by the CoS TUI idle reaper so a dropped connection doesn't get mistaken
 * for a hung or finished agent (a silenced TUI looks identical either way).
 *
 * This is deliberately a bare TCP *connect* to well-known anycast endpoints on
 * :443 — NOT a DNS lookup (we dial IPs directly, so a broken resolver can't read
 * as an outage) and NOT an HTTP/TLS exchange (we only need "can packets leave").
 * It never rejects: callers use it as a gate, and a probe that failed to run is
 * not proof of anything, so the promise always resolves to a boolean.
 *
 * Assumes normal outbound egress (the single-user private-machine model PortOS
 * targets). In a locked-down, proxy-only network where both anycast IPs are
 * blocked, a machine with working internet would read as offline — the caller
 * (the TUI idle reaper) treats that as "defer the reap", which its independent
 * max-runtime backstop still bounds, so the failure mode is a delayed reap, not
 * a wedged agent.
 */

import net from 'net';

// Two independent public resolvers so one operator blocking a single IP (or one
// resolver having a blip) doesn't read as a full outage — reachable if EITHER
// connects.
export const DEFAULT_PROBE_HOSTS = [
  { host: '1.1.1.1', port: 443 }, // Cloudflare
  { host: '8.8.8.8', port: 443 }, // Google
];

export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

// Resolve when a single host connects; reject when it errors or times out.
// Always tears the socket down (listeners + fd) on every terminal path. The
// `setTimeout(timeoutMs)` below guarantees one of connect/timeout/error fires
// even when the caller abandons the promise (e.g. the agent is torn down while
// a probe is in flight), so an in-flight probe self-cleans within `timeoutMs`
// and never dangles — there is no cancellation path that leaks a socket/fd.
function probeHost({ host, port }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      ok ? resolve() : reject(new Error('unreachable'));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Resolve `true` as soon as ANY probe host connects; resolve `false` only after
 * every probe has errored or timed out. Fast even when fully offline (a dead
 * network errors/times out quickly per host). Never rejects.
 *
 * @param {{ timeoutMs?: number, hosts?: Array<{host:string,port:number}> }} [opts]
 * @returns {Promise<boolean>}
 */
export function isMachineOnline({ timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, hosts = DEFAULT_PROBE_HOSTS } = {}) {
  if (!Array.isArray(hosts) || hosts.length === 0) return Promise.resolve(false);
  // Promise.any resolves on the first fulfilled probe and rejects (AggregateError)
  // only when every probe fails — exactly the "true on first connect, false only
  // after all fail" contract. The reject handler swallows it so we never throw.
  return Promise.any(hosts.map((h) => probeHost(h, timeoutMs))).then(() => true, () => false);
}

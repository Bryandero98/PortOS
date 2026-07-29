/**
 * Host-shutdown signal + durable marker.
 *
 * `portos-server` is restarted routinely — pm2's memory ceiling, a manual
 * `pm2 restart`, a code deploy. pm2's TreeKill signals every descendant of the
 * server, so a CoS TUI agent whose PTY the server owns dies WITH the server
 * even though the durable `portos-cos` runner never went down (issue #3202).
 *
 * That teardown is an INTERRUPTION, not an outcome, and PortOS has to be able to
 * tell the two apart later — after the process that witnessed it is gone. Two
 * signals do that:
 *
 *   1. **In-process flag** (`markHostShuttingDown` / `isHostShuttingDown`) —
 *      read by the TUI spawner's PTY-exit handler so a PTY that vanishes mid
 *      shutdown is never finalized as a completed run. Sync, allocation-free,
 *      and safe to set first thing inside a signal handler.
 *   2. **Durable marker** (`writeHostShutdownMarker`) — a small JSON file naming
 *      the agents that were live when the signal arrived. The next boot's orphan
 *      sweep reads it to classify those agents as *interrupted by a host
 *      restart* rather than as ordinary orphans, so they don't burn orphan-retry
 *      budget or trip the 30-minute orphan cooldown for a fault they didn't
 *      cause.
 *
 * The marker is deliberately tiny and best-effort: it is written inside the
 * graceful-shutdown window (which has a hard 10s ceiling), so every function
 * here is non-throwing and returns a falsy/empty result rather than propagating
 * an I/O failure into shutdown. A missing marker simply degrades recovery to the
 * pre-existing orphan path — the old, safe behavior.
 */

import { join } from 'path';
import { rm } from 'fs/promises';
import { PATHS, atomicWrite, readJSONFile } from './fileUtils.js';

/** Completion reason recorded for a run the host restart tore down. */
export const HOST_SHUTDOWN_REASON = 'host-shutdown';

/**
 * Marker file. Lives beside the other CoS state so a data wipe clears it too.
 *
 * Resolved lazily rather than as a module-level constant: this module is
 * imported by the TUI spawner, whose suites stub `fileUtils` with a partial
 * `PATHS`. A `join(PATHS.cos, …)` evaluated at import time throws there and
 * takes the whole suite down with it — for a path most callers never touch.
 */
export const hostShutdownMarkerPath = () => join(PATHS.cos, 'host-shutdown.json');

// Process-local. Never persisted — a fresh process is by definition not the one
// that was shutting down, so this always starts false.
let shuttingDown = false;

/**
 * Latch the in-process shutdown flag. Idempotent; call it as the FIRST thing in
 * a SIGTERM/SIGINT handler, before any await, so anything that races the
 * teardown (a PTY exiting, a finalize hook firing) already sees it.
 */
export function markHostShuttingDown() {
  shuttingDown = true;
}

/** Is this process on its way down? */
export function isHostShuttingDown() {
  return shuttingDown;
}

/**
 * Reset the flag. Test-only — production never un-shuts-down.
 */
export function resetHostShutdownFlagForTests() {
  shuttingDown = false;
}

/**
 * Persist the marker naming the agents that were live at shutdown.
 *
 * @param {object} params
 * @param {string[]} params.agentIds - ids of agents running when the signal landed
 * @param {string} [params.signal] - the signal that triggered shutdown (diagnostic)
 * @returns {Promise<boolean>} true when the marker landed on disk
 */
export async function writeHostShutdownMarker({ agentIds = [], signal = null } = {}) {
  const ids = [...new Set(agentIds.filter((id) => typeof id === 'string' && id))];
  // Nothing was running — don't leave a marker the next boot has to reason
  // about (and don't overwrite a prior one; a marker with no agents is noise).
  if (ids.length === 0) return false;
  const ok = await atomicWrite(hostShutdownMarkerPath(), {
    at: new Date().toISOString(),
    signal,
    agentIds: ids,
  }).then(() => true, (err) => {
    console.error(`❌ Failed to write host-shutdown marker: ${err.message}`);
    return false;
  });
  if (ok) console.log(`🛑 Host shutdown marker written for ${ids.length} live agent(s)`);
  return ok;
}

/**
 * Read the marker left by the previous process.
 *
 * Returns a normalized `{ at, signal, agentIds }` — `agentIds` is ALWAYS an
 * array, so a truncated/garbled marker degrades to "no agents were interrupted"
 * instead of throwing during boot recovery. Returns null when no marker exists.
 */
export async function readHostShutdownMarker() {
  const raw = await readJSONFile(hostShutdownMarkerPath(), null, { logError: false });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    at: typeof raw.at === 'string' ? raw.at : null,
    signal: typeof raw.signal === 'string' ? raw.signal : null,
    agentIds: Array.isArray(raw.agentIds) ? raw.agentIds.filter((id) => typeof id === 'string' && id) : [],
  };
}

/**
 * Remove the marker once boot recovery has consumed it. Non-throwing: a marker
 * that can't be removed would only cause the NEXT boot to re-classify agents
 * that are already settled, which the orphan sweep tolerates (it only ever looks
 * at agents still marked `running`).
 */
export async function clearHostShutdownMarker() {
  await rm(hostShutdownMarkerPath(), { force: true }).catch((err) => {
    console.error(`❌ Failed to clear host-shutdown marker: ${err.message}`);
  });
}

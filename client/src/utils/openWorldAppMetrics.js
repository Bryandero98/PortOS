// Per-building live telemetry (roadmap 1.1). `GET /api/apps` already ships per-process
// PM2 metrics (`cpu` %, `memory` bytes, `uptime` ms, restart counts) inside each app's
// `pm2Status` map — this module aggregates them into the single snapshot the building
// hologram and focus panel render. Pure: no fetching, no React.

const ONLINE_STATES = new Set(['online', 'running']);

const sum = (values) => values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);

/**
 * Aggregate an app's per-process PM2 metrics into one building-level snapshot.
 *
 * CPU and memory sum across ONLINE processes only — a stopped or errored worker
 * reports no live usage, and counting it as 0 would silently deflate a hot app's
 * numbers. Uptime is the MINIMUM uptime among online processes: the honest "how
 * long has this whole app been stable" reading when any worker has recently
 * restarted. Restarts count every process (historical signal, live or not).
 *
 * @param {object|null} app - enriched app record (`pm2Status` from GET /api/apps)
 * @returns {{hasMetrics: boolean, totalProcs: number, onlineProcs: number,
 *   cpuPercent: number|null, memBytes: number, uptimeMs: number|null,
 *   restarts: number, unstableRestarts: number}}
 *   `hasMetrics` is false when the app carries no PM2 status at all (non-PM2 apps,
 *   archived shells, failed reads) so callers can omit the rows entirely instead of
 *   rendering dashes.
 */
export function computeAppMetrics(app) {
  const statuses = Object.values(app?.pm2Status || {});
  const online = statuses.filter((p) => ONLINE_STATES.has(p?.status));
  const uptimes = online.map((p) => p?.uptime).filter(Number.isFinite);

  return {
    hasMetrics: statuses.length > 0,
    totalProcs: statuses.length,
    onlineProcs: online.length,
    cpuPercent: online.length ? Math.round(sum(online.map((p) => p?.cpu)) * 10) / 10 : null,
    memBytes: sum(online.map((p) => p?.memory)),
    uptimeMs: uptimes.length ? Math.min(...uptimes) : null,
    restarts: sum(statuses.map((p) => p?.restarts)),
    unstableRestarts: sum(statuses.map((p) => p?.unstableRestarts)),
  };
}

/**
 * Stress tone for a live metric pair, shared by the hologram row and the focus
 * panel stat blocks so a hot building reads the same everywhere. Thresholds are
 * deliberately coarse — this is glanceable atmosphere, not monitoring.
 */
export function cpuTone(cpuPercent) {
  if (!Number.isFinite(cpuPercent)) return 'idle';
  if (cpuPercent >= 85) return 'hot';
  if (cpuPercent >= 40) return 'busy';
  return 'calm';
}

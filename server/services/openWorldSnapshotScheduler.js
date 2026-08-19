/**
 * OpenWorld Snapshot Scheduler
 *
 * Registers an interval job that periodically captures a OpenWorld state
 * snapshot (see openWorldSnapshots.js). Mirrors the backupScheduler.js pattern.
 *
 * Like the backup scheduler's cron expression, the *interval value* is locked
 * in at registration — changing `intervalMinutes` requires a restart. But the
 * `enabled` toggle is re-read inside the handler on every run, so disabling
 * capture from settings takes effect on the next tick without a restart.
 */

import { schedule, cancel, getEvent } from './eventScheduler.js';
import { captureSnapshot, getSnapshotConfig } from './openWorldSnapshots.js';

const EVENT_ID = 'city-snapshot';

/**
 * Start the snapshot scheduler. No-ops if disabled in settings.
 */
export async function startOpenWorldSnapshotScheduler() {
  const { enabled, intervalMinutes } = await getSnapshotConfig();

  if (!enabled) {
    console.log('🏙️ OpenWorld snapshot scheduler: disabled in settings — skipping');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  schedule({
    id: EVENT_ID,
    type: 'interval',
    intervalMs,
    handler: async () => {
      // Re-read settings each run so an `enabled: false` toggle takes effect
      // without a restart (the interval value itself is locked at registration).
      const current = await getSnapshotConfig();
      if (!current.enabled) {
        console.log('🏙️ OpenWorld snapshot scheduler: disabled since registration — skipping run');
        return;
      }
      const frame = await captureSnapshot();
      console.log(`🏙️ OpenWorld snapshot captured: ${frame.counts.appsOnline}/${frame.counts.appsTotal} apps online, ${frame.counts.agentsActive} agents active`);
    },
    metadata: { source: 'openWorldSnapshotScheduler' },
  });

  console.log(`🏙️ OpenWorld snapshot scheduler: registered every ${intervalMinutes}min`);
}

/**
 * Stop the snapshot scheduler.
 */
export function stopOpenWorldSnapshotScheduler() {
  cancel(EVENT_ID);
  console.log('🏙️ OpenWorld snapshot scheduler: stopped');
}

/**
 * ISO timestamp of the next scheduled capture, or null if not scheduled.
 */
export function getNextSnapshotTime() {
  const event = getEvent(EVENT_ID);
  return event?.nextRunAt ? new Date(event.nextRunAt).toISOString() : null;
}

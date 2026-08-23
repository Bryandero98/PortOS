/**
 * Shared eventScheduler registration for periodic garbage-collection sweeps.
 *
 * Each GC gets one delayed boot pass plus one recurring interval. Keeping both
 * in eventScheduler makes them cancellable and visible in scheduler history.
 */

import { cancel, getEvent, schedule } from './eventScheduler.js';

const INITIAL_SUFFIX = ':initial';

export function createSweepScheduler({ id, intervalMs, initialDelayMs, handler, source }) {
  const initialId = `${id}${INITIAL_SUFFIX}`;

  return {
    start() {
      if (getEvent(id)?.active) return;

      schedule({
        id: initialId,
        type: 'once',
        delayMs: initialDelayMs,
        handler,
        metadata: { source },
      });
      schedule({
        id,
        type: 'interval',
        intervalMs,
        handler,
        metadata: { source },
      });
    },
    stop() {
      cancel(initialId);
      cancel(id);
    },
  };
}

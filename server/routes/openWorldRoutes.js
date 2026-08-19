import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, openWorldSnapshotsQuerySchema } from '../lib/validation.js';
import {
  captureSnapshot,
  getSnapshots,
  getSnapshotConfig,
} from '../services/openWorldSnapshots.js';
import { getNextSnapshotTime } from '../services/openWorldSnapshotScheduler.js';
import { getOpenWorldIntrospection } from '../services/openWorldIntrospection.js';

const router = Router();

// GET /api/openworld/snapshots — the recorded world-state series, oldest-first.
// A future timeline scrubber loads this and drives the 3D scene from a frame.
router.get('/snapshots', asyncHandler(async (req, res) => {
  const { since, limit } = validateRequest(openWorldSnapshotsQuerySchema, req.query);
  res.json(await getSnapshots({ since, limit }));
}));

// POST /api/openworld/snapshots/capture — capture a frame on demand (manual /
// testing trigger; the scheduler drives the periodic captures).
router.post('/snapshots/capture', asyncHandler(async (req, res) => {
  res.json(await captureSnapshot());
}));

// GET /api/openworld/introspection — DB tables + data/ domain sizes for the Data
// Harbor district. Cached server-side (stale-while-revalidate); `db: null`
// means the database is unreachable, distinct from a reachable-but-empty one.
router.get('/introspection', asyncHandler(async (req, res) => {
  res.json(await getOpenWorldIntrospection());
}));

// GET /api/openworld/snapshots/config — effective capture config + next run time.
router.get('/snapshots/config', asyncHandler(async (req, res) => {
  const config = await getSnapshotConfig();
  res.json({ ...config, nextRun: getNextSnapshotTime() });
}));

export default router;

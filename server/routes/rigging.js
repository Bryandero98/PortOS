import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { getRiggingReadiness } from '../services/rigging/readiness.js';

const router = Router();

// The only input this lane accepts: force a re-probe instead of reading the short-lived
// memo. Present so the Settings card's "Recheck" reflects an install the user just ran.
const readinessQuerySchema = z.object({
  refresh: z.enum(['1', 'true']).optional(),
});

/**
 * Whether this host can run character rigging, and — when it cannot — WHY, by a stable
 * reason code the client mirrors to a label (`client/src/lib/riggingReasons.js`).
 *
 * Read-only and on-demand: the Blender import probe runs from here (and from the
 * instance-feature detector), never from `server/index.js` boot, so a fresh install
 * pays nothing at startup for a feature nobody has asked for.
 */
router.get('/readiness', asyncHandler(async (req, res) => {
  const { refresh } = validateRequest(readinessQuerySchema, req.query);
  res.json(await getRiggingReadiness({ refresh: Boolean(refresh) }));
}));

export default router;

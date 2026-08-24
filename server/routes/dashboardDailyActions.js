/**
 * GET /api/dashboard/daily-actions
 *
 * A deterministic, read-only projection of today's product actions. It does
 * not generate anything or call an AI provider; the client can poll it safely
 * for a reminder and the dashboard can render the same action list.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getDailyActions } from '../services/portosProductMetrics.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await getDailyActions());
}));

export default router;

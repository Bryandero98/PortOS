import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { detectSystemCapabilities } from '../lib/systemCapabilities.js';

const router = Router();

// This is deliberately separate from /health/details. Health details are
// scraped and persisted by federation peers; hardware capabilities are local
// selection context and must not silently join a sync payload.
router.get('/', asyncHandler(async (_req, res) => {
  res.json(await detectSystemCapabilities());
}));

export default router;

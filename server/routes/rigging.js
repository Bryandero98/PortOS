import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { rigImageTo3dModel } from '../services/rigging/autoSkin.js';
import { AUTO_SKIN_DEFAULTS, AUTO_SKIN_LIMITS } from '../services/rigging/autoSkinReport.js';
import { getRiggingReadiness } from '../services/rigging/readiness.js';
import { SKELETON_BONE_MAPPINGS } from '../services/rigging/skeletonMapping.js';

const router = Router();

// The only input this lane accepts: force a re-probe instead of reading the short-lived
// memo. Present so the Settings card's "Recheck" reflects an install the user just ran.
const readinessQuerySchema = z.object({
  refresh: z.enum(['1', 'true']).optional(),
});

/**
 * Advanced overrides for one auto-skin run. Both are ABSENT by default: the ceiling and
 * the weld distance are defended thresholds (`autoSkinReport.js` documents why each
 * number is where it is), so a request that omits them gets the defended value, and one
 * that supplies a number gets it validated against the range the gate can still reason
 * about. Nothing here persists between runs.
 */
const rigRequestSchema = z.object({
  skeletonHint: z.enum(Object.keys(SKELETON_BONE_MAPPINGS)).optional(),
  weldDistance: z.number().min(AUTO_SKIN_LIMITS.weldDistanceMin).max(AUTO_SKIN_LIMITS.weldDistanceMax).optional(),
  unweightedCeiling: z.number()
    .min(AUTO_SKIN_LIMITS.unweightedCeilingMin)
    .max(AUTO_SKIN_LIMITS.unweightedCeilingMax)
    .optional(),
});

const modelIdSchema = z.object({ id: z.string().trim().min(1).max(128) });

/**
 * Whether this host can run character rigging, and — when it cannot — WHY, by a stable
 * reason code the client mirrors to a label (`client/src/lib/riggingReasons.js`).
 *
 * Read-only and on-demand: the Blender import probe runs from here (and from the
 * instance-feature detector), never from `server/index.js` boot, so a fresh install
 * pays nothing at startup for a feature nobody has asked for.
 *
 * `defaults` rides along so the client can label the advanced overrides with the real
 * thresholds instead of hardcoding a second copy of them.
 */
router.get('/readiness', asyncHandler(async (req, res) => {
  const { refresh } = validateRequest(readinessQuerySchema, req.query);
  const readiness = await getRiggingReadiness({ refresh: Boolean(refresh) });
  res.json({ ...readiness, defaults: AUTO_SKIN_DEFAULTS, skeletons: Object.keys(SKELETON_BONE_MAPPINGS) });
}));

/**
 * Auto-skin one rendered image-to-3D model against a humanoid armature, publishing the
 * rigged GLB + its report only if the measured weight coverage clears the gate.
 *
 * Explicit user action only — a rig is minutes of local CPU, so nothing here runs from
 * boot or on a schedule. Runs inline (the gate answer is the response) rather than as a
 * background job: refusing to publish is the product, and a fire-and-forget 202 would
 * bury the number that explains the refusal.
 */
router.post('/models/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(modelIdSchema, req.params);
  const options = validateRequest(rigRequestSchema, req.body ?? {});
  res.json(await rigImageTo3dModel(id, options));
}));

export default router;

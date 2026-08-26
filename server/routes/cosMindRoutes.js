/** Persistent Chief-of-Staff mind conversation and lifecycle routes. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { getDomainMode } from '../lib/domainAutonomy.js';
import { PERSISTENT_MIND_LIMITS } from '../lib/persistentMind.js';
import {
  PERSISTENT_MIND_ID,
  PERSISTENT_MIND_TRAJECTORY_LIMITS,
  parsePersistentMindCursor,
} from '../lib/persistentMindTrajectory.js';
import { normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { publicPersistentMindState } from '../lib/persistentMindPublic.js';
import { validateRequest } from '../lib/validation.js';
import { readPersistentMindEvents, readPersistentMindHistory } from '../services/agentRunEventLog.js';
import { loadState } from '../services/cosState.js';
import {
  appendPersistentMindAnnotation,
  promotePersistentMindMemory,
} from '../services/persistentMindContext.js';
import {
  enqueuePersistentMindMessage,
  getPersistentMindState,
  pausePersistentMind,
  resumePersistentMind,
  startPersistentMind,
  stopPersistentMind,
} from '../services/persistentMindSupervisor.js';

const router = Router();

const idempotencyId = z.string().trim().min(1).max(200);
const eventId = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(PERSISTENT_MIND_LIMITS.MAX_MESSAGE_CHARS);
const mindReadSchema = z.object({
  cursor: z.string().max(260).refine((value) => parsePersistentMindCursor(value) !== null, 'Invalid cursor').optional(),
  limit: z.coerce.number().int().positive().max(PERSISTENT_MIND_TRAJECTORY_LIMITS.maxPageSize).optional(),
}).strict();
const messageSchema = z.object({ id: idempotencyId, text }).strict();
const annotationSchema = z.object({
  id: idempotencyId,
  text,
  turnId: z.string().trim().min(1).max(128).nullable().optional(),
  targetEventId: eventId.nullable().optional(),
}).strict();
const pauseSchema = z.object({ reason: z.string().trim().min(1).max(PERSISTENT_MIND_LIMITS.MAX_REASON_CHARS).optional() }).strict();
const acknowledgementSchema = z.object({ id: idempotencyId }).strict();
const eventParamsSchema = z.object({ eventId }).strict();
const promotionSchema = z.object({
  id: idempotencyId,
  approved: z.literal(true),
  content: z.string().trim().min(1).max(10_240),
  summary: z.string().trim().max(500).optional(),
  turnId: z.string().trim().min(1).max(128).nullable().optional(),
  type: z.enum(['fact', 'preference', 'pattern', 'insight', 'context']).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
}).strict();

const requireSuccess = (result) => {
  if (result?.success === false) {
    throw new ServerError(result.error || 'Persistent mind request was refused', { status: 409, code: 'INVALID_STATE' });
  }
  return result;
};

const requireMindEvent = async (targetEventId) => {
  const events = await readPersistentMindHistory(PERSISTENT_MIND_ID);
  if (!events.some((event) => event.eventId === targetEventId)) {
    throw new ServerError('Persistent mind event not found', { status: 404, code: 'NOT_FOUND' });
  }
};

router.get('/mind', asyncHandler(async (req, res) => {
  const query = validateRequest(mindReadSchema, req.query);
  const [history, state, root] = await Promise.all([
    readPersistentMindEvents({ mindId: PERSISTENT_MIND_ID, ...query }),
    getPersistentMindState(),
    loadState(),
  ]);
  const profile = normalizePersistentMindProfile(root.config?.persistentMindProfile);
  res.json({
    ...history,
    state: publicPersistentMindState(state),
    profile: {
      enabled: profile.enabled,
      providerId: profile.providerId || null,
      model: profile.model || null,
      effort: profile.effort || null,
      thinkingInterface: profile.thinkingInterface,
    },
    autonomyMode: getDomainMode(root.config, 'cos'),
  });
}));

router.post('/mind/messages', asyncHandler(async (req, res) => {
  const input = validateRequest(messageSchema, req.body);
  res.status(202).json(requireSuccess(await enqueuePersistentMindMessage(input)));
}));

router.post('/mind/annotations', asyncHandler(async (req, res) => {
  const input = validateRequest(annotationSchema, req.body);
  const result = await appendPersistentMindAnnotation(input);
  if (result.error) throw new ServerError(result.error, { status: 409, code: 'INVALID_STATE' });
  res.status(202).json({ success: true, duplicate: result.duplicate === true, annotationId: input.id });
}));

router.post('/mind/start', asyncHandler(async (_req, res) => {
  res.json(requireSuccess(await startPersistentMind()));
}));

router.post('/mind/pause', asyncHandler(async (req, res) => {
  const { reason } = validateRequest(pauseSchema, req.body ?? {});
  const result = requireSuccess(await pausePersistentMind(reason));
  res.json({ success: true, state: publicPersistentMindState(result.state) });
}));

router.post('/mind/resume', asyncHandler(async (_req, res) => {
  res.json(requireSuccess(await resumePersistentMind()));
}));

router.post('/mind/stop', asyncHandler(async (_req, res) => {
  res.json(requireSuccess(await stopPersistentMind()));
}));

router.post('/mind/events/:eventId/acknowledge', asyncHandler(async (req, res) => {
  const { eventId: targetEventId } = validateRequest(eventParamsSchema, req.params);
  const { id } = validateRequest(acknowledgementSchema, req.body);
  await requireMindEvent(targetEventId);
  const result = await appendPersistentMindAnnotation({
    id,
    targetEventId,
    text: 'Acknowledged by user',
  });
  if (result.error) throw new ServerError(result.error, { status: 409, code: 'INVALID_STATE' });
  res.status(202).json({ success: true, duplicate: result.duplicate === true, acknowledgementId: id });
}));

router.post('/mind/events/:eventId/promote', asyncHandler(async (req, res) => {
  const { eventId: sourceEventId } = validateRequest(eventParamsSchema, req.params);
  const input = validateRequest(promotionSchema, req.body);
  await requireMindEvent(sourceEventId);
  const result = requireSuccess(await promotePersistentMindMemory({ ...input, sourceEventId }));
  res.status(201).json({ success: true, memoryId: result.memory?.id || null });
}));

export default router;

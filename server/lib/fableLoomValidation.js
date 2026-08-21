/**
 * Zod schemas for the FableLoom routes. Length caps come straight from
 * LOOM_LIMITS (the sanitizer's constants) so the door check and the
 * enforcement layer can never drift — the sprite/creative-commission
 * validation modules follow the same import-the-service-constants pattern.
 */

import { z } from 'zod';
import { LOOM_LIMITS } from '../services/fableLoom/limits.js';

const name = z.string().trim().min(1).max(LOOM_LIMITS.NAME_MAX);
const logline = z.string().max(LOOM_LIMITS.LOGLINE_MAX);
const premise = z.string().max(LOOM_LIMITS.PREMISE_MAX);
const styleNotes = z.string().max(LOOM_LIMITS.STYLE_NOTES_MAX);
const refId = z.string().max(LOOM_LIMITS.REF_ID_MAX).nullable();
const title = z.string().max(LOOM_LIMITS.EPISODE_TITLE_MAX);
const synopsis = z.string().max(LOOM_LIMITS.SYNOPSIS_MAX);
const nodeIdStr = z.string().min(1).max(80);

export const loomCreateSchema = z.object({
  name,
  logline: logline.optional(),
  premise: premise.optional(),
  styleNotes: styleNotes.optional(),
  universeId: refId.optional(),
  seriesId: refId.optional(),
});

export const loomPatchSchema = z.object({
  name: name.optional(),
  logline: logline.optional(),
  premise: premise.optional(),
  styleNotes: styleNotes.optional(),
  universeId: refId.optional(),
  seriesId: refId.optional(),
});

export const episodeCreateSchema = z.object({
  title: title.optional(),
  synopsis: synopsis.optional(),
});

export const episodePatchSchema = z.object({
  title: title.optional(),
  synopsis: synopsis.optional(),
  number: z.number().int().min(1).max(9999).optional(),
  startNodeId: nodeIdStr.nullable().optional(),
});

const transitionSchema = z.object({
  id: z.string().max(80).optional(),
  targetNodeId: nodeIdStr,
  intent: z.string().max(LOOM_LIMITS.INTENT_MAX),
  triggers: z.array(z.string().max(LOOM_LIMITS.TRIGGER_MAX)).max(LOOM_LIMITS.TRIGGERS_MAX).optional(),
  description: z.string().max(LOOM_LIMITS.TRANSITION_DESC_MAX).optional(),
});

const nodeFields = {
  title: z.string().max(LOOM_LIMITS.NODE_TITLE_MAX).optional(),
  prose: z.string().max(LOOM_LIMITS.PROSE_MAX).optional(),
  imagePrompt: z.string().max(LOOM_LIMITS.IMAGE_PROMPT_MAX).optional(),
  isEnding: z.boolean().optional(),
  endingLabel: z.string().max(LOOM_LIMITS.ENDING_LABEL_MAX).optional(),
  pos: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  transitions: z.array(transitionSchema).max(LOOM_LIMITS.TRANSITIONS_MAX).optional(),
};

export const nodeCreateSchema = z.object({
  ...nodeFields,
  // Optionally wire the new scene in as a branch of an existing one.
  fromNodeId: nodeIdStr.optional(),
  fromIntent: z.string().max(LOOM_LIMITS.INTENT_MAX).optional(),
});

export const nodePatchSchema = z.object(nodeFields);

const llmPickFields = {
  providerId: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
};

export const weaveSchema = z.object({
  guidance: z.string().max(4000).optional(),
  nodeTarget: z.number().int().min(3).max(60).optional(),
  endingTarget: z.number().int().min(1).max(12).optional(),
  replace: z.boolean().optional(),
  ...llmPickFields,
});

export const branchSchema = z.object({
  guidance: z.string().max(4000).optional(),
  branchCount: z.number().int().min(1).max(4).optional(),
  ...llmPickFields,
});

export const reviewSchema = z.object({ ...llmPickFields });

export const playTurnSchema = z.object({
  nodeId: nodeIdStr,
  message: z.string().min(1).max(1000),
  transcript: z.array(z.object({
    role: z.enum(['reader', 'narrator']),
    text: z.string().max(4000),
  })).max(50).optional(),
  ...llmPickFields,
});

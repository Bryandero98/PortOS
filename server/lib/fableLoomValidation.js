/**
 * Zod schemas for the FableLoom routes. Length caps mirror LOOM_LIMITS in
 * server/services/fableLoom/records.js — the sanitizer is the enforcement
 * layer; these reject obviously-oversized payloads at the door.
 */

import { z } from 'zod';

const name = z.string().trim().min(1).max(200);
const logline = z.string().max(500);
const premise = z.string().max(20000);
const styleNotes = z.string().max(4000);
const refId = z.string().max(64).nullable();
const title = z.string().max(300);
const synopsis = z.string().max(4000);
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
  intent: z.string().max(120),
  triggers: z.array(z.string().max(160)).max(8).optional(),
  description: z.string().max(500).optional(),
});

const nodeFields = {
  title: title.optional(),
  prose: z.string().max(20000).optional(),
  imagePrompt: z.string().max(2000).optional(),
  isEnding: z.boolean().optional(),
  endingLabel: z.string().max(200).optional(),
  pos: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  transitions: z.array(transitionSchema).max(12).optional(),
};

export const nodeCreateSchema = z.object({
  ...nodeFields,
  // Optionally wire the new scene in as a branch of an existing one.
  fromNodeId: nodeIdStr.optional(),
  fromIntent: z.string().max(120).optional(),
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

/**
 * Opt-in action capabilities for the persistent Chief-of-Staff mind.
 *
 * Provider/profile configuration controls inference. This separate slice
 * controls which typed side effects a completed mind turn may request, so an
 * existing conversation-only install never gains new authority on upgrade.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';
import { PR_COMPLETION_VALUES } from './prDisposition.js';

export const PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION = 1;

// The persistent mind has a deliberately smaller surface than ordinary CoS
// agents. Keep this catalog beside the capability schema so the API and the UI
// describe the same grants instead of maintaining a second client-only list.
export const PERSISTENT_MIND_TOOL_CATALOG = Object.freeze([
  Object.freeze({
    id: 'cos.create-task',
    capability: 'createTasks',
    name: 'Queue CoS agent tasks',
    description: 'Request a bounded, typed CoS task for an app using a configured coding provider.',
    kind: 'typed-action',
    defaultEnabled: false,
    guardrails: [
      'Up to five requests per turn',
      'Configured app, provider, model, effort, mode, and completion policy are re-validated before queueing',
      'Implementation work runs through the normal isolated-worktree, autonomy, budget, review, CI, and PR gates',
      'Plan & File Issue requests use the existing issue-only planning contract',
    ],
  }),
]);

export const PERSISTENT_MIND_TOOL_BOUNDARIES = Object.freeze([
  'No arbitrary shell or file-system access',
  'No direct access to onboard tools such as image generation or browser controls',
  'No provider credentials or hidden reasoning tokens are exposed as tools',
]);

export const PERSISTENT_MIND_TASK_LIMITS = Object.freeze({
  maxPerTurn: 5,
  descriptionChars: 500,
  promptChars: 12_000,
  appIdChars: 128,
  providerIdChars: 100,
  modelChars: 200,
});

export const persistentMindCapabilitiesSchema = z.object({
  schemaVersion: z.literal(PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION).optional(),
  createTasks: z.boolean().optional(),
}).strict();

export const persistentMindTaskRequestSchema = z.object({
  description: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.descriptionChars),
  prompt: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.promptChars),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().default('MEDIUM'),
  appId: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.appIdChars),
  providerId: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.providerIdChars),
  // Empty means "use this provider's configured default" — a real choice for
  // providers whose CLI owns model selection and publishes no concrete ids.
  model: z.string().trim().max(PERSISTENT_MIND_TASK_LIMITS.modelChars),
  effort: z.union([z.literal(''), z.enum(EFFORT_LEVELS)]).optional().default(''),
  // `planOnly` is the User Task form's issue-only mode. It deliberately does
  // not require a PR disposition because the task store forces the
  // no-worktree/no-PR posture for it. Implementation tasks still must choose a
  // disposition so the mind cannot silently inherit a different landing gate.
  // Keep absence meaningful for replay compatibility: adding a default here
  // would change the canonical fingerprint of an older implementation request
  // and could queue it twice after an install upgrades.
  planOnly: z.boolean().optional(),
  prCompletion: z.enum(PR_COMPLETION_VALUES).optional(),
}).strict().superRefine((value, context) => {
  if (!value.planOnly && !value.prCompletion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prCompletion'],
      message: 'Implementation tasks require a PR completion policy',
    });
  }
});

export function createDefaultPersistentMindCapabilities() {
  return {
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    createTasks: false,
  };
}

export function normalizePersistentMindCapabilities(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    createTasks: source.createTasks === true,
  };
}

export function mergePersistentMindCapabilities(previous, update) {
  const prior = normalizePersistentMindCapabilities(previous);
  const patch = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  return normalizePersistentMindCapabilities({ ...prior, ...patch });
}

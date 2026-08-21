/**
 * Creative-Director-domain creative tools (CDO Phase 3, #2185). The
 * pipeline/autopilot → Creative Director direction of the bridge: mint + start a
 * fresh CD teaser/trailer video project seeded from a pipeline issue. Wraps the
 * `produceVideoFromIssue` conductor (createProject + setTreatment + auto-cast +
 * start — never mutates an existing project's treatment, the #842 rule).
 */

import { z } from 'zod';
import { produceVideoFromIssue } from '../../creativeDirector/bridgeFromIssue.js';
import { getProject } from '../../creativeDirector/local.js';
import { COST_LLM } from './shared.js';

/**
 * What the teaser this tool mints inherits from the project that called it: the
 * render pin (#3135) and the owning commission.
 *
 * A creative commission stamps its `generation.videoMode`/`.videoModelId` onto
 * the project it runs in (creativeCommissions/abilityAdapters.js), but the teaser
 * is a SEPARATE project — without this the pin stops at that boundary and the
 * teaser renders on the install default. `commissionId` carries for the same
 * reason and one more: it is how the commission finds this project to STOP it,
 * and how the teaser's own cognitive stages resolve the commission's live
 * provider. An orphaned teaser would keep generating after the commission that
 * asked for it was paused or deleted.
 *
 * Deliberately NOT in the tool schema: the planner LLM must not be able to pick
 * a render backend. The pin is the user's configured choice, so it's read from
 * the project record and spread UNDER the parsed args, which carry no
 * `renderBackend`/`modelId` keys for the model to override it with.
 *
 * Best-effort — a project-less dispatch or an unreadable record just means "no
 * inherited pin", the same as before pins existed.
 */
async function inheritedRenderSettings(ctx) {
  if (!ctx?.projectId) return {};
  const project = await getProject(ctx.projectId).catch(() => null);
  if (!project) return {};
  return {
    ...(project.renderBackend ? { renderBackend: project.renderBackend } : {}),
    ...(project.modelId ? { modelId: project.modelId } : {}),
    ...(project.commissionId ? { commissionId: project.commissionId } : {}),
  };
}

export const CD_TOOLS = [
  {
    name: 'cd_produceVideoFromIssue',
    description:
      'Mint AND start a fresh Creative Director teaser/trailer video project seeded from a pipeline issue. '
      + 'Generates a treatment from the issue\'s prose/script + series canon, auto-casts the series ingredients, links the source issue (for the music bed), and kicks off rendering. '
      + 'Non-destructive: always creates a NEW project, never overwrites an existing one. Costs one LLM call for the treatment; the project\'s renders proceed asynchronously.',
    costClass: COST_LLM,
    schema: z.object({
      issueId: z.string().min(1),
      name: z.string().max(200).optional(),
      aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
      quality: z.enum(['draft', 'standard', 'high']).optional(),
      targetDurationSeconds: z.number().int().min(5).max(600).optional(),
    }),
    parameters: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Pipeline issue id to seed the teaser from (required).' },
        name: { type: 'string', description: 'Project name (defaults to "<issue title> — Teaser").' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: 'Video aspect ratio (default 16:9).' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'], description: 'Render quality (default standard).' },
        targetDurationSeconds: { type: 'integer', description: 'Target teaser length in seconds (5–600, default 60).' },
      },
      required: ['issueId'],
    },
    execute: async ({ issueId, ...options }, ctx) =>
      produceVideoFromIssue(issueId, { ...await inheritedRenderSettings(ctx), ...options }),
  },
];

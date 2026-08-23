/**
 * Forge selection helpers shared by prompt sections.
 */

import { forgeCliForTracker, resolveRepoForgeTarget } from '../../lib/workTracker.js';

export function normalizeForgeCli(value) {
  if (value === 'glab' || value === 'gitlab') return 'glab';
  if (value === 'gh' || value === 'github') return 'gh';
  return null;
}

export function manualForgeCli(forgeCli, worktreeInfo) {
  return normalizeForgeCli(forgeCli)
    || normalizeForgeCli(worktreeInfo?.forgeCli)
    || forgeCliForTracker(worktreeInfo?.forge)
    || 'gh';
}

export async function resolveManualForgeCli(workspaceDir, worktreeInfo, task) {
  const explicit = manualForgeCli(null, worktreeInfo);
  if (explicit !== 'gh') return explicit;
  const preferredForge = normalizeForgeCli(task?.metadata?.workTracker);
  const target = await resolveRepoForgeTarget(worktreeInfo?.worktreePath || workspaceDir, {
    preferredForge: preferredForge === 'glab' ? 'gitlab' : preferredForge === 'gh' ? 'github' : null,
  }).catch(() => null);
  return forgeCliForTracker(target?.forge) || explicit;
}

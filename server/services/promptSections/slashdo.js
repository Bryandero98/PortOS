/**
 * Slashdo invocation expansion for agent prompts.
 */

import { loadSlashdoFile, writeResolvedSlashdoBody } from '../../lib/slashdoLoader.js';
import { resolveSlashdoInvocation, buildSlashdoSection, unreachableReviewerIncludes, SLASHDO_INLINE_BUDGET_CHARS } from '../../lib/slashdoInvocation.js';
import { DEFAULT_REVIEWER, resolveReviewerConfig, buildReviewerEffortNote, buildReviewersCsv } from '../../lib/validation.js';

/**
 * Fold a slashdo-backed task's invocation + procedure into its description (#3089).
 *
 * A task that names a bundled workflow persists only the BARE command
 * (`metadata.slashdoCommand`) because the form's provider select defaults to
 * "Auto" — the concrete shape (`/do:x`, `/do-x`, or an Agent Skill selected by
 * name) is only knowable here, once the scheduler has picked a provider.
 *
 * The command body travels with the prompt for every provider, not just the
 * skill-style ones: PortOS ships slashdo as a submodule and only surfaces it as
 * slash commands via the repo-local `.claude/commands/do/` symlinks, which don't
 * exist in the managed-app workspaces most CoS tasks run in.
 *
 * **Size control (#3110).** Expanded bodies run 38KB–317KB. Two independent
 * reductions apply, in this order:
 *
 * 1. **Prune unreachable reviewer variants.** `review`/`better`/`pr` each paste
 *    all five of slashdo's reviewer loops though one run drives one of them.
 *    Pruning to a single CLI reviewer measured -23% on `review` (258,260 →
 *    198,997 chars), -27% on `pr`, and -28% on `depfree`. (slashdo's
 *    orchestration wrapper is never pruned — it dispatches even a single-entry
 *    reviewer list — which is ~37KB of the theoretical ceiling.)
 * 2. **Point at a resolved copy on disk when still over budget** — but only for a
 *    host with file tools (`cli`/`tui`; an HTTP `api` provider has none and
 *    inlines with a warning). On its own this is roughly token-NEUTRAL for an
 *    agent that reads the whole procedure; it pays off when the host can invoke
 *    slashdo natively or needs only part of the body.
 *
 * Pruning is only sound if the run then uses the reviewers we pruned FOR, so the
 * section emits an explicit `--review-with` pin alongside a pruned body —
 * otherwise the agent could resolve a different reviewer from slashdo's own saved
 * defaults and find that loop missing. No explicit pin ⇒ no prune.
 *
 * The reviewers, usernames, and optional-reviewers are resolved through the SAME
 * three helpers as the inline `/do:pr` completion path further down
 * (`normalizeReviewers` / `resolveReviewUsernames` / `resolveOptionalReviewers`),
 * so what we prune for is exactly what the rest of the prompt resolves — legacy
 * single-`reviewer` tasks and defaults-inherited `optionalReviewers` included.
 *
 * The one case that does NOT authorize pruning is a resolved lone `copilot` that
 * nothing named explicitly (no task pin, no username reviewers, not marked
 * optional): `pickCodeReviewDefaults` and `normalizeReviewers` both fall back to
 * `['copilot']`, so that value can't be told apart from an unconfigured install —
 * and pinning `--review-with copilot` where Copilot review isn't enabled is the
 * #2507 stall. This mirrors `buildReviewWithArgs`'s lone-default suppression,
 * including its exemption for an explicitly-optional copilot.
 *
 * Applied to the description (on a COPY — the stored task is untouched) rather
 * than emitted as its own template slot, because the briefing template renders
 * `{{task.description}}`: a new `{{slashdoSection}}` placeholder would be
 * silently dropped by every install whose customized template predates it.
 *
 * @returns {Promise<Object>} the task, or a copy carrying the invocation
 */
export async function applySlashdoInvocation(task, {
  providerId = null, providerCommand = null, leanMode = false, hasFileTools = false,
  defaultReviewers = null, codeReviewDefaults = null,
} = {}) {
  const command = task.metadata?.slashdoCommand;
  const resolved = resolveSlashdoInvocation({
    command,
    args: task.metadata?.slashdoArgs || '',
    providerId,
    providerCommand,
    leanMode,
  });
  if (!resolved) return task;

  // Resolved through the SAME three helpers the inline `/do:pr` completion path
  // uses below (`taskReviewers` / `taskReviewerUsernames` / `taskOptionalReviewers`),
  // so the reviewers we prune for are exactly the ones the rest of the prompt
  // resolves. Hand-rolling `metadata.reviewers` here instead dropped the legacy
  // single `reviewer` string and the defaults' `optionalReviewers` — pruning for
  // one reviewer while the run resolved another, and pinning an optional reviewer
  // as blocking.
  const {
    reviewers: resolvedReviewers,
    usernames: resolvedUsernames,
    optionalReviewers: resolvedOptional,
    reviewerMaxRounds: resolvedMaxRounds,
    reviewerModels: resolvedModels,
    reviewerEfforts: resolvedEfforts
  } = resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers);

  // A resolved lone `copilot` with no usernames is ambiguous: it's what an
  // unconfigured install produces (`pickCodeReviewDefaults` and
  // `normalizeReviewers` both fall back to `['copilot']`), so it can't be told
  // apart from a real choice UNLESS something names it explicitly. Absent that,
  // treat it as unconfigured and prune nothing — pinning `--review-with copilot`
  // where Copilot review isn't enabled is the #2507 stall.
  //
  // Marking copilot OPTIONAL — or giving it a `~max=<n>` round cap — is such an
  // explicit naming: nothing defaults to either suffix, so both are deliberate
  // choices, and dropping one would silently turn a non-blocking review blocking
  // or spend an unbudgeted number of rounds. `buildReviewWithArgs` makes the same
  // exemption for its lone-default suppression — keep the two in step. It carries a
  // third clause for a copilot `~effort=`; there is deliberately none here, because
  // copilot has no effort ladder at all (`REVIEWER_EFFORT_LEVELS` is keyed off
  // `reviewerCliBinary`, and copilot names no binary), so `normalizeReviewerEfforts`
  // drops the pin long before either function sees it.
  const taskPinnedReviewer = (Array.isArray(task.metadata?.reviewers) && task.metadata.reviewers.length > 0)
    || (typeof task.metadata?.reviewer === 'string' && !!task.metadata.reviewer);
  const optionalDefaultReviewer = resolvedOptional.some(t => t.toLowerCase() === DEFAULT_REVIEWER);
  const cappedDefaultReviewer = Object.keys(resolvedMaxRounds)
    .some(t => t.toLowerCase() === DEFAULT_REVIEWER);
  const isBareDefault = resolvedReviewers.length === 1
    && resolvedReviewers[0] === DEFAULT_REVIEWER
    && !resolvedUsernames.length
    && !taskPinnedReviewer
    && !optionalDefaultReviewer
    && !cappedDefaultReviewer;
  const skipIncludes = isBareDefault
    ? []
    : unreachableReviewerIncludes({ reviewers: resolvedReviewers, usernames: resolvedUsernames });

  const body = await loadSlashdoFile(command, { stripFrontmatter: true, skipIncludes }).catch(() => null);
  if (!body) console.log(`⚠️ Slashdo command body unavailable, sending invocation only: ${command}`);
  const overBudget = !!body && body.length > SLASHDO_INLINE_BUDGET_CHARS;
  // An HTTP `api` provider can't read a file, so an over-budget body is pasted
  // whole. Surface the cost rather than paying it silently.
  if (overBudget && !hasFileTools) {
    console.warn(`⚠️ Inlining ${Math.round(body.length / 1000)}KB slashdo body for API provider (no file tools): ${command}`);
  }
  // Only spend the write when the pointer will actually be used.
  const bodyPath = (overBudget && hasFileTools)
    ? await writeResolvedSlashdoBody(command, body, { skipIncludes }).catch((err) => {
        console.warn(`⚠️ Could not stage slashdo body for ${command}, inlining instead: ${err.message}`);
        return null;
      })
    : null;

  const reviewWith = skipIncludes.length
    ? buildReviewersCsv(resolvedReviewers, resolvedUsernames, resolvedOptional, resolvedMaxRounds, resolvedModels, resolvedEfforts)
    : '';
  // Gated on the PIN, not on pruning. When `reviewWith` is emitted, each token
  // carries `~effort=<level>` and slashdo's loop applies it — the note would only
  // have the agent pass the flag twice. When nothing is pinned, the workflow
  // resolves reviewers itself and the note is the pin's only route to the CLI it
  // spawns (the `/do:pr` completion step further down is a different invocation
  // entirely, and for a slashdo-backed task usually isn't reached).
  const reviewerEffortNote = buildReviewerEffortNote(resolvedReviewers, resolvedEfforts, { reviewWith, reviewerModels: resolvedModels });
  // Plan-only supplies destination/approval flags as slashdo args, so preserve
  // the task description bridge that those flags would otherwise suppress.
  const includeTaskContext = task.metadata?.planOnly === true || task.metadata?.planOnly === 'true';
  const section = buildSlashdoSection(resolved, body, {
    bodyPath,
    reviewWith,
    reviewerEffortNote,
    includeTaskContext,
  });
  return { ...task, description: `${task.description}\n\n${section}` };
}

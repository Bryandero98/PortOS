/**
 * PR disposition for CoS agent tasks — who lands the pull request a task opens.
 *
 * The default is that *something* lands it: the review-loop follow-up when a
 * Review Loop is configured, a merge follow-up (or the agent's own completion
 * workflow) on green CI when it isn't. A PR nobody merges is a leaked branch.
 *
 * The exception is a task that deliberately hands its PR to a human AND records
 * that hand-off somewhere PortOS can't update afterwards. `jira-sprint-manager`
 * is the case that exists today: its prompt transitions the ticket to "In
 * Review", so merging the PR behind the board's back would leave the work merged
 * and the ticket permanently in review — and nothing in the completion path
 * knows the ticket key to transition it to Done.
 *
 * This lives in `lib/` because both halves of the decision need it: the prompt
 * builder (agent-owned PR flows, where the agent merges) and the worktree
 * cleanup (PortOS-owned PR flows, where a follow-up agent merges). A predicate
 * that only one half consults produces exactly the split-brain it's meant to
 * prevent.
 */

/**
 * Scheduled task types whose prompt hands the PR to a human. Keep this tiny —
 * every entry is a PR a person must remember to merge.
 */
export const PR_STAYS_OPEN_TASK_TYPES = Object.freeze(['jira-sprint-manager']);

const PR_STAYS_OPEN_SET = new Set(PR_STAYS_OPEN_TASK_TYPES);

/**
 * True when a task's PR must be left open for a human rather than merged: an
 * exempt task type, or any task carrying a JIRA ticket (the ticket status is the
 * hand-off, and no completion path here can transition it).
 *
 * Reviewers still run when configured — this governs the *merge*, not the review.
 *
 * @param {Object|null} task - the CoS task (or its metadata holder).
 * @returns {boolean}
 */
export function leavesPrForHuman(task) {
  const metadata = task?.metadata || {};
  return PR_STAYS_OPEN_SET.has(metadata.analysisType) || !!metadata.jiraTicketId;
}

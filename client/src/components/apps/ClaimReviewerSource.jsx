import { Link } from 'react-router';

/**
 * Where a claim's reviewer list came from, in one sentence.
 *
 * Shared by the two manual claim surfaces because they were already drifting on
 * the answer: a claim resolves the claim-work task metadata FIRST and only falls
 * back to the install-wide Code Review Defaults, so a user who changed the
 * defaults and sees a different chain needs to be sent to whichever one is
 * actually supplying it — and being sent to the wrong panel is the same class of
 * confusion as not being told at all.
 *
 * The override lives on the `claim-work` task, editable both globally (Chief of
 * Staff → Schedule) and per app (the app's Automation tab), so the copy names
 * the task rather than a single screen.
 */
export default function ClaimReviewerSource({ source }) {
  if (source === 'task-override') {
    return (
      <>
        {' — from the '}<strong className="text-port-warning">claim-work</strong>{' reviewer override ('}
        <Link to="/cos/schedule" className="text-port-accent hover:underline">Chief of Staff → Schedule</Link>
        {', or this app’s Automation tab), not Models → Code Reviewers. Clear it there to follow the install default again.'}
      </>
    );
  }
  return (
    <>
      {' — from '}
      <Link to="/models/code-reviewers" className="text-port-accent hover:underline">Models → Code Reviewers</Link>.
    </>
  );
}

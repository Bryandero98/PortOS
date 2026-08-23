import { describeCron } from '../../../../utils/cronHelpers';
import { badge, INTERVAL_LABELS, INTERVAL_BADGE_VARIANT } from './scheduleConstants';

export default function IntervalBadge({ type, cronExpression }) {
  const label = INTERVAL_LABELS[type] || type;
  const cronDesc = type === 'cron' && cronExpression ? describeCron(cronExpression) : null;
  const title = type === 'cron' && cronExpression
    ? (cronDesc ? `${cronDesc} (${cronExpression})` : cronExpression)
    : undefined;

  return (
    <span
      className={`${badge(INTERVAL_BADGE_VARIANT[type] || 'success')} whitespace-nowrap shrink-0`}
      title={title}
    >
      {label}
    </span>
  );
}

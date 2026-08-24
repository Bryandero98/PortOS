import CronSchedulePicker from './CronSchedulePicker';

/**
 * Day-of-week + time-of-day picker that reads/writes a cron expression.
 *
 * Toggle the days it should run and set the time — no crontab syntax. No days
 * selected means every day (a daily schedule). `value` is a cron string;
 * `onChange` receives the rebuilt cron string. When `value` is an
 * interval/stepped cron the picker can't represent, the pills show unselected
 * and the first interaction converts it into a simple day+time cron.
 */
export default function WeekdayTimePicker({ value, onChange, className = '' }) {
  return (
    <CronSchedulePicker
      value={value}
      onChange={onChange}
      className={className}
      showAdvanced={false}
      showSummary={false}
    />
  );
}

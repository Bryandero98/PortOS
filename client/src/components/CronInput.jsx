import { useState } from 'react';
import { DEFAULT_CRON } from '../utils/cronHelpers';
import CronSchedulePicker from './CronSchedulePicker';

/**
 * Inline cron expression editor with a day-of-week + time-of-day picker.
 *
 * The picker is the easy path: toggle the days it should run and set the time,
 * no crontab syntax required (no days selected = every day). A collapsible
 * "advanced" row keeps the raw expression + presets for interval/stepped crons
 * the picker can't represent. Calls onSave with the validated expression,
 * onCancel to dismiss.
 */
export default function CronInput({ value, onSave, onCancel, className = '' }) {
  const [expr, setExpr] = useState(value || DEFAULT_CRON);

  const handleSave = () => {
    const trimmed = expr.trim();
    if (trimmed.split(/\s+/).length !== 5) return;
    onSave(trimmed);
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <CronSchedulePicker
          value={expr}
          onChange={setExpr}
          onCronKeyDown={event => {
            if (event.key === 'Enter') handleSave();
            if (event.key === 'Escape') onCancel?.();
          }}
        />
        <button
          type="button"
          onClick={handleSave}
          className="px-1.5 py-1 bg-port-accent/20 text-port-accent rounded text-xs hover:bg-port-accent/30"
        >
          OK
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel custom cron expression"
            className="px-1.5 py-1 text-gray-500 hover:text-gray-300 rounded text-xs"
          >
            X
          </button>
        )}
      </div>

    </div>
  );
}

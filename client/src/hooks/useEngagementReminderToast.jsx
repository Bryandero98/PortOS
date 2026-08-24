import { useCallback, useRef } from 'react';
import { Link } from 'react-router';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import { safeReadJsonSession, safeWriteJsonSession } from '../lib/safeStorage';
import { useAutoRefetch } from './useAutoRefetch';

const SESSION_KEY = 'portos:engagement-reminders:v1';
const MAX_REMINDER_KEYS = 100;

function ReminderToast({ t, action }) {
  return (
    <div className="flex flex-col gap-2 max-w-[min(480px,calc(100vw-4rem))]">
      <div className="flex items-start gap-2">
        <span className="text-port-warning" aria-hidden="true">⚠️</span>
        <span className="font-medium text-port-text text-sm flex-1">{action.title}</span>
      </div>
      <p className="text-xs text-port-text-muted">{action.detail}</p>
      <div className="flex items-center gap-2 pt-1 border-t border-port-border/30">
        <Link
          to={action.link || '/'}
          onClick={() => toast.dismiss(t.id)}
          className="inline-flex items-center justify-center min-h-[40px] px-3 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-xs font-medium"
        >
          Open action
        </Link>
        <button
          type="button"
          onClick={() => toast.dismiss(t.id)}
          className="inline-flex items-center justify-center min-h-[40px] px-3 text-xs text-port-text-muted hover:text-port-text"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Poll the deterministic daily-action projection and show each actionable
 * reminder once per browser tab/day. The session guard keeps a route reload
 * from repeatedly interrupting the user while still allowing a new day's POST
 * prompt or the next unrated commission run to surface.
 */
export function useEngagementReminderToast() {
  const shownRef = useRef(null);
  if (shownRef.current === null) {
    const stored = safeReadJsonSession(SESSION_KEY, {});
    shownRef.current = new Set(stored && typeof stored === 'object' ? Object.keys(stored) : []);
  }

  const showReminder = useCallback((today, action) => {
    if (!action?.id) return;
    const key = `${today || 'unknown'}:${action.id}`;
    if (shownRef.current.has(key)) return;
    shownRef.current.add(key);
    const recent = [...shownRef.current].slice(-MAX_REMINDER_KEYS);
    shownRef.current = new Set(recent);
    safeWriteJsonSession(SESSION_KEY, Object.fromEntries(recent.map((item) => [item, true])));
    toast((t) => <ReminderToast t={t} action={action} />, {
      id: `engagement-reminder-${key}`,
      duration: 12000,
      icon: null,
      label: action.title,
    });
  }, []);

  const fetchActions = useCallback(async () => {
    const data = await api.getDailyActions({ silent: true });
    for (const action of data?.actions || []) showReminder(data.today, action);
    return data;
  }, [showReminder]);

  useAutoRefetch(fetchActions, 300000, { pollOnly: true });
}

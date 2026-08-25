import { memo } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Brain, Sparkles } from 'lucide-react';

const ACTION_ICONS = {
  post_engagement: Brain,
  commission_feedback: Sparkles,
};

const ACTION_TONES = {
  high: 'border-port-warning/50 bg-port-warning/10',
  medium: 'border-port-accent/40 bg-port-accent/10',
};

/**
 * Landing-card projection of the same deterministic actions used by the
 * proactive-alert and reminder-toast surfaces. It reads dashboardState rather
 * than fetching inside a widget, so the dashboard has one refresh boundary.
 */
const DailyActionsWidget = memo(function DailyActionsWidget({ dashboardState }) {
  const actions = dashboardState?.dailyActions?.actions || [];
  if (actions.length === 0) return null;

  return (
    <section className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6" aria-labelledby="daily-actions-heading">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 p-2 rounded-lg bg-port-warning/10">
            <ArrowRight className="w-5 h-5 text-port-warning" />
          </div>
          <div className="min-w-0">
            <h3 id="daily-actions-heading" className="text-lg font-semibold text-port-text">Today&apos;s actions</h3>
            <p className="text-sm text-port-text-muted truncate">Small actions that keep your feedback loops moving</p>
          </div>
        </div>
        <span className="shrink-0 text-xs text-port-warning bg-port-warning/10 rounded-full px-2 py-1">
          {actions.length} waiting
        </span>
      </div>

      <div className="space-y-2">
        {actions.map((action) => {
          const Icon = ACTION_ICONS[action.type] || ArrowRight;
          return (
            <Link
              key={action.id}
              to={action.link || '/'}
              className={`flex items-start gap-3 p-3 rounded-lg border ${ACTION_TONES[action.severity] || ACTION_TONES.medium} hover:brightness-110 transition-all min-h-[64px] group`}
            >
              <Icon size={17} className="mt-0.5 shrink-0 text-port-accent" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-port-text truncate">{action.title}</span>
                <span className="block text-xs text-port-text-muted mt-0.5">{action.detail}</span>
              </span>
              <ArrowRight size={16} className="mt-0.5 shrink-0 text-port-text-subtle group-hover:text-port-accent transition-colors" />
            </Link>
          );
        })}
      </div>
    </section>
  );
});

export default DailyActionsWidget;

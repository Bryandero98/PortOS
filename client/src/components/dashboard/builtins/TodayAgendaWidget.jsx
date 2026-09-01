import { Link } from 'react-router';
import { CalendarDays, ArrowRight } from 'lucide-react';

// Glanceable "what's left today" agenda. Reads the shared `calendarAgenda`
// slice of dashboardState (populated from GET /api/calendar/agenda — the
// server owns the timezone-correct day window, so this never re-derives it)
// and deep-links into Calendar → Agenda. Gated off until the user has a
// calendar account connected.

const timeLabel = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

export default function TodayAgendaWidget({ dashboardState }) {
  const agenda = dashboardState?.calendarAgenda;
  if (!agenda) return null;

  const now = Date.now();
  const events = Array.isArray(agenda.events) ? agenda.events : [];
  // An event is "done" once it has ended (all-day events never dim).
  const isPast = (e) => {
    if (e.isAllDay) return false;
    const end = new Date(e.endTime || e.startTime).getTime();
    return Number.isFinite(end) && end < now;
  };
  const nextEvent = events.find((e) => !e.isAllDay && !isPast(e));
  const remaining = events.filter((e) => !isPast(e)).length;
  const overflow = (agenda.total ?? events.length) - events.length;

  return (
    <Link
      to="/calendar/agenda"
      className="bg-port-card border border-port-border rounded-xl p-4 h-full block hover:border-gray-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-3">
        <CalendarDays size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-white">Today&apos;s Agenda</h3>
        <span className="ml-auto flex items-center gap-1 text-xs text-port-accent">
          Open <ArrowRight size={12} />
        </span>
      </div>

      {events.length === 0 ? (
        <div className="text-xs text-gray-500">Nothing on the calendar today 🎉</div>
      ) : (
        <>
          <div className="text-xs text-gray-500 mb-2">
            {remaining} of {agenda.total ?? events.length} event{(agenda.total ?? events.length) !== 1 ? 's' : ''} remaining
          </div>
          <ul className="space-y-1">
            {events.map((e) => {
              const past = isPast(e);
              const isNext = nextEvent && e === nextEvent;
              return (
                <li
                  key={`${e.accountId}:${e.id}`}
                  className={`flex items-center gap-2 text-xs ${past ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`shrink-0 w-16 tabular-nums ${isNext ? 'text-port-accent font-semibold' : 'text-gray-500'}`}
                  >
                    {e.isAllDay ? 'All day' : timeLabel(e.startTime) || 'TBD'}
                  </span>
                  <span
                    className={`flex-1 truncate ${past ? 'line-through text-gray-500' : 'text-gray-300'}`}
                    title={e.location ? `${e.title} — ${e.location}` : e.title}
                  >
                    {e.title}
                  </span>
                </li>
              );
            })}
          </ul>
          {overflow > 0 && (
            <div className="text-xs text-gray-500 mt-2">+{overflow} more</div>
          )}
        </>
      )}
    </Link>
  );
}

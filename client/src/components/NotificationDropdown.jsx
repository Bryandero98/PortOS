import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Bell, X, CheckCheck, Trash2, Brain, ListTodo, AlertTriangle, Code, HelpCircle, BellRing, Sparkles } from 'lucide-react';
import { timeAgo } from '../utils/formatters';
import { clickableProps } from '../lib/a11yKeyboard';
import useClickOutside from '../hooks/useClickOutside.js';
import usePopoverPosition, { VIEWPORT_PADDING } from '../hooks/usePopoverPosition.js';

const NOTIFICATION_TYPE_CONFIG = {
  memory_approval: {
    icon: Brain,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20'
  },
  task_approval: {
    icon: ListTodo,
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/20'
  },
  code_review: {
    icon: Code,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/20'
  },
  health_issue: {
    icon: AlertTriangle,
    color: 'text-red-400',
    bgColor: 'bg-red-500/20'
  },
  plan_question: {
    icon: HelpCircle,
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/20'
  },
  agent_warning: {
    icon: AlertTriangle,
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/20'
  },
  daily_post_reminder: {
    icon: BellRing,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20'
  },
  creative_commission: {
    icon: Sparkles,
    color: 'text-port-accent',
    bgColor: 'bg-port-accent/20'
  }
};

const COLLAPSED_LIMIT = 10;
const PANEL_WIDTH = 320;

const PRIORITY_COLORS = {
  low: 'border-gray-500/30',
  medium: 'border-yellow-500/30',
  high: 'border-orange-500/50',
  critical: 'border-red-500/50'
};

export default function NotificationDropdown({
  notifications,
  unreadCount,
  onMarkAsRead,
  onMarkAllAsRead,
  onRemove,
  onClearAll,
  position = 'above' // 'above' prefers opening upward, 'below' downward
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const containerRef = useRef(null);
  const navigate = useNavigate();

  // The panel is portaled to <body> and placed in viewport coordinates. That is
  // what keeps it on-screen from this trigger: the bell sits mid-screen in the
  // sidebar footer, so an absolutely-positioned 320px panel ran off the right
  // edge on a phone — titles clipped, dismiss and mark-all/clear-all controls
  // unreachable with nothing to scroll. The hook clamps into the viewport and
  // flips above/below, so there is no breakpoint branch to keep in sync. Height
  // changes (expanding the list) re-measure via contentDeps.
  const { triggerRef, popoverRef, style: panelStyle } = usePopoverPosition({
    open: isOpen,
    width: PANEL_WIDTH,
    minWidth: 260,
    position,
    contentDeps: [showAll, notifications.length]
  });

  // Both refs: the panel lives outside the trigger's subtree once portaled, so a
  // trigger-only containment check would read clicks on the panel as outside.
  useClickOutside([containerRef, popoverRef], isOpen, () => setIsOpen(false));

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  // Collapse back to the first page each time the panel is dismissed
  useEffect(() => {
    if (!isOpen) setShowAll(false);
  }, [isOpen]);

  const handleNotificationClick = (notification) => {
    if (!notification.read) {
      onMarkAsRead(notification.id);
    }
    if (notification.link) {
      navigate(notification.link);
      setIsOpen(false);
    }
  };

  const visible = showAll ? notifications : notifications.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = notifications.length - visible.length;

  return (
    <div className="relative" ref={containerRef}>
      {/* Bell button with badge */}
      <button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className="relative inline-flex items-center justify-center min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 sm:p-2 rounded-lg hover:bg-port-card transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent focus:ring-offset-2 focus:ring-offset-port-bg"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <Bell className={`w-5 h-5 ${unreadCount > 0 ? 'text-yellow-400' : 'text-gray-400'}`} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold rounded-full bg-port-warning text-port-on-warning px-1" aria-hidden="true">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && createPortal(
        <div
          ref={popoverRef}
          role="menu"
          aria-label="Notifications menu"
          className="fixed bg-port-card border border-port-border rounded-lg shadow-xl z-[100] overflow-hidden"
          style={{
            left: panelStyle?.left ?? `${VIEWPORT_PADDING}px`,
            top: panelStyle?.top ?? `${VIEWPORT_PADDING}px`,
            width: panelStyle?.width ?? `${PANEL_WIDTH}px`,
            visibility: panelStyle ? 'visible' : 'hidden'
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
            <span className="font-medium text-white">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={onMarkAllAsRead}
                  className="p-1.5 rounded hover:bg-port-border transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent"
                  title="Mark all as read"
                  aria-label="Mark all notifications as read"
                >
                  <CheckCheck className="w-4 h-4 text-gray-400" aria-hidden="true" />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  type="button"
                  onClick={onClearAll}
                  className="p-1.5 rounded hover:bg-port-border transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent"
                  title="Clear all"
                  aria-label="Clear all notifications"
                >
                  <Trash2 className="w-4 h-4 text-gray-400" aria-hidden="true" />
                </button>
              )}
              {/* Touch has no Escape key, and a tall panel can be clamped over the
                  bell, so mobile needs an explicit dismiss it can always reach. */}
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded hover:bg-port-border transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent sm:hidden"
                title="Close"
                aria-label="Close notifications"
              >
                <X className="w-4 h-4 text-gray-400" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Notification list */}
          <div className="max-h-[60dvh] overflow-y-auto sm:max-h-96">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500">
                No notifications
              </div>
            ) : (
              visible.map(notification => {
                const config = NOTIFICATION_TYPE_CONFIG[notification.type] || NOTIFICATION_TYPE_CONFIG.task_approval;
                const Icon = config.icon;

                return (
                  <div
                    key={notification.id}
                    className={`
                      group px-4 py-3 border-b border-port-border last:border-b-0 cursor-pointer
                      hover:bg-port-border/50 transition-colors focus:outline-hidden focus:bg-port-border/50
                      ${!notification.read ? 'bg-port-border/30' : ''}
                      border-l-2 ${PRIORITY_COLORS[notification.priority] || PRIORITY_COLORS.medium}
                    `}
                    onClick={() => handleNotificationClick(notification)}
                    {...clickableProps(() => handleNotificationClick(notification), { role: 'menuitem' })}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`p-1.5 rounded ${config.bgColor}`} aria-hidden="true">
                        <Icon className={`w-4 h-4 ${config.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <span className={`min-w-0 flex-1 text-sm font-medium break-words ${!notification.read ? 'text-white' : 'text-gray-300'}`}>
                            {notification.title}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemove(notification.id);
                            }}
                            className="shrink-0 inline-flex items-center justify-center min-w-[44px] min-h-[44px] -my-2 rounded hover:bg-port-border transition-colors sm:min-w-0 sm:min-h-0 sm:my-0 sm:p-1 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-port-accent"
                            aria-label={`Remove notification: ${notification.title}`}
                          >
                            <X className="w-4 h-4 text-gray-500 sm:w-3 sm:h-3" aria-hidden="true" />
                          </button>
                        </div>
                        {notification.description && (
                          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                            {notification.description}
                          </p>
                        )}
                        <div className="flex items-center gap-3 mt-1 sm:gap-2">
                          <span className="text-[10px] text-gray-600">
                            {timeAgo(notification.timestamp)}
                          </span>
                          {!notification.read && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onMarkAsRead(notification.id);
                              }}
                              className="text-[10px] text-port-accent hover:underline py-2 -my-2 sm:py-0 sm:my-0"
                            >
                              Mark read
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Actionable, so the overflow is reachable rather than merely counted */}
          {hiddenCount > 0 && (
            <div className="border-t border-port-border text-center">
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full px-4 py-3 text-xs text-port-accent hover:bg-port-border/50 transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent sm:py-2"
              >
                Show {hiddenCount} more notification{hiddenCount === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

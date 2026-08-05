import { useState, useRef, useEffect } from 'react';
import { Play, ChevronDown, Package } from 'lucide-react';
import { triggerButtonClass, IMPROVEMENT_DISABLED_TITLE, SAVING_TITLE } from './scheduleConstants';

// Trigger an on-demand run. When the task targets managed apps, opens a picker
// so the run carries app context; otherwise fires a plain global run. Shared by
// the schedule card and the drawer's global-config controls so both stay in sync.
//
// `saving` means a provider/model/effort pin is still being persisted. The run
// reads the server-side config, so triggering mid-write would run the previous
// settings — hence a hard disable rather than a tooltip.
export default function RunTaskButton({ taskType, apps, onTrigger, improvementDisabled, saving = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const activeApps = apps?.filter(app => !app.archived) || [];
  const disabled = improvementDisabled || saving;
  const disabledTitle = improvementDisabled ? IMPROVEMENT_DISABLED_TITLE : SAVING_TITLE;

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Without this, an open dropdown survives a flip to disabled and pops back open when re-enabled.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (activeApps.length === 0) {
    return (
      <span title={disabled ? disabledTitle : 'Run this task immediately (bypasses schedule)'} className="inline-block">
        <button
          type="button"
          onClick={() => !disabled && onTrigger(taskType)}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          className={triggerButtonClass(disabled)}
        >
          <Play size={14} />
          Run Now
        </button>
      </span>
    );
  }

  return (
    <div className="relative" ref={ref}>
      {/* Tooltip on the wrapper, not the button: most browsers skip hover events on disabled controls. */}
      <span title={disabled ? disabledTitle : 'Run this task on a specific app'} className="inline-block">
        <button
          type="button"
          onClick={() => !disabled && setOpen(o => !o)}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          aria-expanded={open}
          className={triggerButtonClass(disabled)}
        >
          <Play size={14} />
          Run on App
          <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </span>
      {open && !disabled && (
        <div className="port-menu-surface absolute bottom-full left-0 mb-1 z-50 w-64 max-w-[calc(100vw-2rem)] max-h-64 overflow-y-auto border border-port-border rounded-lg shadow-lg">
          <div className="p-2 border-b border-port-border">
            <span className="text-xs text-gray-400">Select an app to run {taskType} on:</span>
          </div>
          <div className="py-1">
            {activeApps.map(app => (
              <button
                key={app.id}
                type="button"
                onClick={() => { onTrigger(taskType, app.id); setOpen(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-port-border/50 flex items-center gap-2 min-h-[40px]"
              >
                <Package size={14} className="text-gray-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-white truncate">{app.name}</div>
                  {app.repoPath && <div className="text-xs text-gray-500 truncate">{app.repoPath}</div>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

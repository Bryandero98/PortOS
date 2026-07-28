/**
 * Toast notification system — replaces react-hot-toast
 * Supports: toast(), toast.success(), toast.error(), toast.loading(), toast.dismiss(), <Toaster />
 * Render-prop toasts: toast((t) => <Component t={t} />, opts) — t has { id }
 *
 * A `duration: Infinity` toast collapses to a corner pill after
 * COLLAPSE_AFTER_MS so it stops blocking clicks on the page beneath it. Such a
 * toast with render-prop content MUST pass `label` — the pill can't name itself
 * from JSX, and `a11yConventions.test.js` enforces it.
 */

import { useState, useEffect } from 'react';
import { uuidv4 } from '../../lib/uuid.js';

let toasts = [];
const listeners = new Set();

function notify() {
  listeners.forEach(fn => fn([...toasts]));
}

const DEFAULT_DURATION = 4000;
const DEDUP_WINDOW_MS = 1500;

// How long a `duration: Infinity` toast stays at full size before folding into
// a corner pill. The stack is `fixed`, `z-[9999]` and `pointer-events-auto`, so
// a toast that never dismisses is a permanent click sink over the page: an
// install whose `outOfSync` notice parked in the bottom-right corner covered
// the CoS task form's Screenshot and Attach buttons, and clicking them did
// nothing at all — no picker, no error, nothing in the console.
//
// Only unbounded toasts collapse. A finite duration is a bound the caller
// already chose and it clears itself, so folding one early would hide an action
// the caller meant to keep offering for the whole time (the manuscript
// Undo-fix toast runs 10s and its Undo button is the only one there is).
export const COLLAPSE_AFTER_MS = 8000;

// Fingerprint → expiry timestamp. Same content+type within DEDUP_WINDOW_MS is
// silently dropped so a single user action that flows through multiple error
// channels (API client toast + socket error:occurred + error:notified) doesn't
// stack 3-4 identical red toasts. Render-prop content (functions) is never
// deduped — those are intentional custom UIs and the caller controls identity.
const recentFingerprints = new Map();
const fingerprintFor = (content, type) =>
  typeof content === 'string' ? `${type}::${content}` : null;

function add(content, opts = {}, type = 'default') {
  // `uuidv4`, not `crypto.randomUUID` — the latter is undefined on insecure
  // origins (PortOS over plain HTTP via Tailscale), where it threw out of
  // every toast, including the ones the API client raises to report a failure.
  const id = opts.id || uuidv4();
  const duration = opts.duration !== undefined ? opts.duration : (type === 'loading' ? Infinity : DEFAULT_DURATION);

  // Skip if an identical toast was just shown — but only when the caller
  // didn't supply an explicit id (explicit id = caller is intentionally
  // updating the same toast, e.g. a loading-then-success swap).
  if (!opts.id) {
    const fp = fingerprintFor(content, type);
    if (fp) {
      const now = Date.now();
      // Sweep expired entries opportunistically.
      for (const [k, exp] of recentFingerprints) {
        if (exp <= now) recentFingerprints.delete(k);
      }
      const expiry = recentFingerprints.get(fp);
      if (expiry && expiry > now) return id;
      recentFingerprints.set(fp, now + DEDUP_WINDOW_MS);
    }
  }

  // `label` names the toast once it collapses to a pill — required for
  // render-prop content, whose JSX the pill can't summarise on its own.
  const entry = { id, type, content, icon: opts.icon, duration, style: opts.style, label: opts.label };

  const idx = toasts.findIndex(t => t.id === id);
  toasts = idx !== -1
    ? [...toasts.slice(0, idx), entry, ...toasts.slice(idx + 1)]
    : [...toasts, entry];
  notify();

  if (duration !== Infinity) setTimeout(() => dismiss(id), duration);
  return id;
}

function dismiss(id) {
  toasts = id !== undefined ? toasts.filter(t => t.id !== id) : [];
  notify();
}

export const toast = Object.assign(
  (content, opts = {}) => add(content, opts, 'default'),
  {
    success: (content, opts = {}) => add(content, opts, 'success'),
    error:   (content, opts = {}) => add(content, opts, 'error'),
    loading: (content, opts = {}) => add(content, opts, 'loading'),
    warning: (content, opts = {}) => add(content, opts, 'warning'),
    dismiss,
  }
);

export default toast;

const TYPE_ICON = { success: '✓', error: '✕', loading: '⟳', warning: '⚠' };
const TYPE_CLASS = { success: 'text-port-success', error: 'text-port-error', loading: 'text-gray-400 animate-spin', warning: 'text-port-warning' };

export function Toaster({ position = 'bottom-right', toastOptions = {} }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const fn = ts => setItems(ts);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  const posClass = {
    'bottom-right':  'bottom-4 right-4 items-end',
    'bottom-left':   'bottom-4 left-4 items-start',
    'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2 items-center',
    'top-right':     'top-4 right-4 items-end',
    'top-left':      'top-4 left-4 items-start',
    'top-center':    'top-4 left-1/2 -translate-x-1/2 items-center',
  }[position] ?? 'bottom-4 right-4 items-end';

  return (
    // Notification region. Each toast is its own live region: role="alert"
    // (implicitly assertive) for errors, role="status" (implicitly polite)
    // otherwise, so screen readers announce toasts as they arrive. The role's
    // implicit live semantics are relied on WITHOUT a redundant aria-live —
    // pairing both on one node double-announces in iOS VoiceOver. Announcing
    // per-toast rather than on the container avoids the whole stack being
    // re-read when one entry changes.
    <div
      className={`fixed ${posClass} z-[9999] flex flex-col gap-2 pointer-events-none`}
      role="region"
      aria-label="Notifications"
    >
      {items.map(t => (
        <ToastItem key={t.id} t={t} toastOptions={toastOptions} />
      ))}
    </div>
  );
}

function ToastItem({ t, toastOptions }) {
  const style = { padding: '12px 16px', borderRadius: '8px', ...toastOptions.style, ...t.style };
  const iconStr = t.icon ?? (t.type !== 'default' ? TYPE_ICON[t.type] : null);
  const iconClass = t.type !== 'default' ? TYPE_CLASS[t.type] : '';
  // Only a toast that never dismisses itself can outstay its welcome and start
  // eating clicks — see COLLAPSE_AFTER_MS.
  const collapsible = t.duration === Infinity;
  const [collapsed, setCollapsed] = useState(false);
  // Held open while the pointer is over the toast or focus is inside it —
  // collapsing out from under a hover would yank the buttons the user is
  // reaching for, and collapsing while focus is inside would drop that focus
  // to <body>.
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!collapsible || collapsed || held) return undefined;
    const timer = setTimeout(() => setCollapsed(true), COLLAPSE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [collapsible, collapsed, held]);

  // Re-entering `add()` with the same id replaces the entry in place (a
  // loading→success swap, a coalesced AI-status error picking up another
  // failure). That toast has something new to say, so unfold it — otherwise the
  // update lands inside a pill nobody opens. `content`/`type` only change
  // identity when `add()` actually ran, so this doesn't fire on re-renders.
  useEffect(() => { setCollapsed(false); }, [t.content, t.type]);

  // Collapsing HIDES the body, it does not unmount it: render-prop toasts own
  // their lifecycle (useAgentFeedbackToast's card runs its own auto-dismiss),
  // and unmounting would destroy those timers and strand the pill forever.
  // `display: none` inline beats the `flex` utility class, and takes the body
  // out of the a11y tree and out of hit-testing — which is the whole point.
  //
  // `collapsible` is re-read during render, not just in the effect, so a
  // loading→success swap on the same id (Infinity → 4000) unfolds in the same
  // commit. The reset effect below would get there a paint later, which shows
  // as a frame of pill over the new message.
  const isCollapsed = collapsed && collapsible;
  const bodyStyle = isCollapsed ? { ...style, display: 'none' } : style;

  return (
    <>
      {isCollapsed && (
        // The pill deliberately carries no hover handlers: the timer effect
        // short-circuits on `collapsed` before it reads `held`, so they couldn't
        // change anything — and the pill unmounts on click, where no
        // `mouseleave` ever fires, which would strand `held` at true and
        // suppress the re-collapse below. Re-expanding doesn't pin the toast
        // open either; the timer just restarts, so a tap on a touch device
        // folds it away again on its own.
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label={collapsedLabel(t)}
          className="pointer-events-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-port-card border border-port-border shadow-lg text-sm"
        >
          <span className={iconClass} aria-hidden="true">{iconStr ?? '•'}</span>
        </button>
      )}
      <div
        style={bodyStyle}
        role={t.type === 'error' ? 'alert' : 'status'}
        onMouseEnter={() => setHeld(true)}
        onMouseLeave={() => setHeld(false)}
        // onFocus/onBlur bubble in React, so these fire for the toast's buttons too.
        onFocus={() => setHeld(true)}
        onBlur={() => setHeld(false)}
        className="pointer-events-auto flex items-start gap-2 shadow-lg text-sm max-w-[calc(100vw-2rem)] sm:max-w-[520px] bg-port-card border border-port-border">
        {iconStr && <span className={`shrink-0 ${iconClass}`} aria-hidden="true">{iconStr}</span>}
        <div className="flex-1 min-w-0">
          {typeof t.content === 'function' ? t.content({ id: t.id }) : <span>{t.content}</span>}
        </div>
      </div>
    </>
  );
}

// Accessible name for the collapsed pill. String content names itself; a
// render-prop toast has to supply `label` or it collapses to an anonymous badge.
function collapsedLabel(t) {
  if (t.label) return `Show notification: ${t.label}`;
  if (typeof t.content === 'string') return `Show notification: ${t.content}`;
  return 'Show notification';
}

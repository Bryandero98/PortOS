import { useEffect, useRef } from 'react';
import { isEditableTarget } from './useKeyboardShortcuts.js';

/**
 * Capture-phase keyboard listener whose handlers *claim* an event by returning
 * true. A claimed event is `preventDefault`ed and `stopImmediatePropagation`ed,
 * so no app-global bubble-phase handler ever sees it — notably the voice
 * widget's push-to-talk hotkey, which defaults to `Space` and would otherwise
 * open the mic every time the user hits Space on a Space-driven surface.
 * Un-claimed events pass through untouched, so this never becomes a blanket
 * keyboard trap.
 *
 * Events originating in an editable field are never offered to the handlers, so
 * a Space-driven surface that also has a text input keeps normal typing. Nor are
 * events fired while an `aria-modal` dialog is open: the surface is behind that
 * dialog, and claiming Escape there would dismiss the surface instead of the
 * layer the user is actually looking at. A surface that itself lives INSIDE a
 * dialog passes `enabledInDialog: true` to opt back in. Both the option name and
 * its default mirror `useKeyboardShortcuts`.
 *
 * Handlers are read through refs, so inline arrows recreated every render (the
 * common call-site shape) don't tear down and re-add the listeners; only
 * `enabled` flips the subscription. A handler that is absent entirely doesn't
 * subscribe its listener at all.
 *
 * @param {object}   opts
 * @param {boolean}  [opts.enabled=true]           attach while truthy
 * @param {boolean}  [opts.enabledInDialog=false]  also fire while a dialog is open
 * @param {(e: KeyboardEvent) => boolean} [opts.onKeyDown] return true to claim
 * @param {(e: KeyboardEvent) => boolean} [opts.onKeyUp]   return true to claim
 */
export default function useKeyCapture({ enabled = true, enabledInDialog = false, onKeyDown, onKeyUp } = {}) {
  const downRef = useRef(onKeyDown);
  const upRef = useRef(onKeyUp);
  downRef.current = onKeyDown;
  upRef.current = onKeyUp;

  // Presence, not identity — a call site that always passes a handler keeps one
  // stable subscription no matter how often its inline arrow is recreated.
  const hasDown = Boolean(onKeyDown);
  const hasUp = Boolean(onKeyUp);

  useEffect(() => {
    if (!enabled) return undefined;
    const claim = (ref) => (e) => {
      if (isEditableTarget(e.target)) return;
      if (!enabledInDialog && document.querySelector('[aria-modal="true"]')) return;
      if (ref.current?.(e) !== true) return;
      e.preventDefault();
      // Subsumes stopPropagation: also skips the remaining listeners on window.
      e.stopImmediatePropagation();
    };
    const down = hasDown ? claim(downRef) : null;
    const up = hasUp ? claim(upRef) : null;
    if (down) window.addEventListener('keydown', down, true);
    if (up) window.addEventListener('keyup', up, true);
    return () => {
      if (down) window.removeEventListener('keydown', down, true);
      if (up) window.removeEventListener('keyup', up, true);
    };
  }, [enabled, enabledInDialog, hasDown, hasUp]);
}

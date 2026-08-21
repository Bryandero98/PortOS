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
 * a Space-driven surface that also has a text input keeps normal typing.
 *
 * Handlers are read through refs, so inline arrows recreated every render (the
 * common call-site shape) don't tear down and re-add the listeners; only
 * `enabled` flips the subscription.
 *
 * @param {object}   opts
 * @param {boolean}  [opts.enabled=true]  attach while truthy
 * @param {(e: KeyboardEvent) => boolean} [opts.onKeyDown] return true to claim
 * @param {(e: KeyboardEvent) => boolean} [opts.onKeyUp]   return true to claim
 */
export default function useKeyCapture({ enabled = true, onKeyDown, onKeyUp } = {}) {
  const downRef = useRef(onKeyDown);
  const upRef = useRef(onKeyUp);
  downRef.current = onKeyDown;
  upRef.current = onKeyUp;

  useEffect(() => {
    if (!enabled) return undefined;
    const claim = (ref) => (e) => {
      if (isEditableTarget(e.target)) return;
      if (ref.current?.(e) !== true) return;
      e.preventDefault();
      // Subsumes stopPropagation: also skips the remaining listeners on window.
      e.stopImmediatePropagation();
    };
    const down = claim(downRef);
    const up = claim(upRef);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [enabled]);
}

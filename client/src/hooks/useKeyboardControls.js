import { useRef, useEffect, useCallback } from 'react';
import { shouldIgnoreGlobalKey } from '../lib/a11yKeyboard.js';

// Movement input is only ever meant for the world behind the UI, so a keystroke aimed at
// a form field, at a focused HUD button, or at an open dialog must not reach the rig:
// typing "w" in the fast-travel search would otherwise walk the avatar, Space on a focused
// HUD button would jump AND press the button, and Space inside the settings drawer would
// jump it (Tab likewise has to move focus in those contexts, not flip exploration mode).
// The shared predicate is the same one PlayerController's own Space claim consults, so the
// two agree on when the rig stands down. Chords and auto-repeat stay allowed through: the
// rig reads held keys, so dropping either would strand or stutter a movement key.
// Note this is a keyDOWN-only gate — keyup always clears, or a key held when a dialog
// opens would stay stuck down forever.
const ignoresMovement = (e) => shouldIgnoreGlobalKey(e, { allowChords: true, ignoreRepeat: false });

export default function useKeyboardControls(onToggleMode) {
  const keysRef = useRef(new Set());

  const handleKeyDown = useCallback((e) => {
    if (ignoresMovement(e)) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      onToggleMode?.();
      return;
    }
    keysRef.current.add(e.key.toLowerCase());
  }, [onToggleMode]);

  const handleKeyUp = useCallback((e) => {
    keysRef.current.delete(e.key.toLowerCase());
  }, []);

  const handleBlur = useCallback(() => {
    keysRef.current.clear();
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [handleKeyDown, handleKeyUp, handleBlur]);

  return keysRef;
}

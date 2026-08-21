import { useRef, useEffect, useCallback } from 'react';
import { isEditableTarget } from '../lib/a11yKeyboard.js';

// Movement input is only ever meant for the world behind the UI, so a keystroke aimed at
// a form field or at an open dialog must not reach the rig: typing "w" in the fast-travel
// search would otherwise walk the avatar, and Space inside the settings drawer would jump
// it (Tab likewise has to move focus in those contexts, not flip exploration mode).
// Note this is a keyDOWN-only gate — keyup always clears, or a key held when a dialog
// opens would stay stuck down forever.
const ignoresMovement = (e) => isEditableTarget(e.target) || Boolean(document.querySelector('[aria-modal="true"]'));

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

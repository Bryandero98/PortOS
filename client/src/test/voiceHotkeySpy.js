import { vi, beforeEach, afterEach } from 'vitest';

/**
 * Stand-in for the voice widget's app-global push-to-talk hotkey, which binds
 * Space (and every other key) on `window` in the bubble phase.
 *
 * Any surface that claims a key through `useKeyCapture` is claiming it *from*
 * this listener, so "did the key leak?" is the assertion those suites keep
 * needing. Call this at the top of a `describe`; it registers its own
 * beforeEach/afterEach and returns a getter for the current spy.
 *
 *   const voiceHotkey = installVoiceHotkeySpy();
 *   …
 *   expect(voiceHotkey()).not.toHaveBeenCalled();
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.keyup=false]  also spy on keyup (held-key surfaces)
 * @returns {() => import('vitest').Mock}
 */
export function installVoiceHotkeySpy({ keyup = false } = {}) {
  let spy;
  beforeEach(() => {
    spy = vi.fn();
    window.addEventListener('keydown', spy);
    if (keyup) window.addEventListener('keyup', spy);
  });
  afterEach(() => {
    window.removeEventListener('keydown', spy);
    if (keyup) window.removeEventListener('keyup', spy);
  });
  return () => spy;
}

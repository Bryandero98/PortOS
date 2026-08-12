// Dictation/IME bridge for the xterm.js terminal.
//
// ── The bug this fixes ─────────────────────────────────────────────────────────
// Apple dictation (iOS "mic" key, macOS Fn Fn) does not emit one final phrase —
// it streams progressively refined guesses and REPLACES what it previously wrote
// in the focused field. In a normal <textarea> that is invisible: the field's
// value goes "dde" → "deter" → "determin" → "determines", each edit replacing the
// last. xterm.js, though, is a character STREAM: its hidden textarea listener
// (`CoreBrowserTerminal#_inputEvent`) forwards `inputType: 'insertText'` events
// verbatim and ignores every deletion event, because a terminal has no notion of
// "replace what I just sent". So each refinement is appended to the PTY and the
// user gets the accumulated garble:
//
//   ddedeterdetermindeterminedetermines ifdetermines if any code…
//
// ── The fix ────────────────────────────────────────────────────────────────────
// Intercept textarea input events in the capture phase (on an ancestor, so we run
// BEFORE xterm's own textarea listener) and forward a DIFF instead of the raw
// insertion: DEL (0x7f) for each character the field dropped, then whatever it
// gained. The textarea keeps accumulating exactly as the OS intends, and the PTY
// sees the same edits a real text field would apply.
//
// Resync points (a keystroke xterm handles itself, blur, paste, composition end)
// reset the mirror without emitting anything, because those paths send to the PTY
// through xterm and may clear the textarea out from under us.

// 0x7f — what a terminal expects for "erase the previous character".
export const DEL = '\x7f';

// Input events whose effect we translate into terminal input ourselves. Anything
// outside this list (paste, undo, composition text, line breaks) is already
// handled by xterm or the keydown path, so it only resyncs our mirror.
const OWNED_INPUT_TYPES = new Set([
  'insertText',
  'insertReplacementText',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
]);

export const commonPrefixLength = (a, b) => {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
};

/**
 * Translate a text-field edit into terminal input.
 *
 * @param {string} mirror   what the field held when we last forwarded it
 * @param {string} next     what the field holds now
 * @param {number} floor    how much of `mirror` predates our tracking. Characters
 *   below the floor reached the PTY some other way (typed keystrokes, a paste),
 *   so we must never emit DELs for them — rewinding there would eat text we
 *   didn't write. Diverging below the floor is only reachable by interleaving
 *   physical edits with dictation mid-phrase; we retype from the floor instead,
 *   which can duplicate a few characters but never deletes someone else's.
 * @returns {string} the bytes to send to the PTY ('' when nothing changed)
 */
export const diffToTerminalInput = (mirror, next, floor = 0) => {
  const common = commonPrefixLength(mirror, next);
  if (common === mirror.length && common === next.length) return '';
  const safeFloor = Math.max(0, Math.min(floor, mirror.length));
  const rewindTo = Math.max(common, safeFloor);
  return DEL.repeat(mirror.length - rewindTo) + next.slice(rewindTo);
};

/**
 * Wire the dictation bridge onto a live xterm instance's hidden textarea.
 *
 * @param {object} params
 * @param {HTMLElement} params.container — an ANCESTOR of the textarea (the element
 *   passed to `term.open()`). Listeners bind here in the capture phase so they run
 *   before xterm's own textarea listeners and can stop the event from reaching them.
 * @param {HTMLTextAreaElement} params.textarea — `term.textarea`
 * @param {(data: string) => void} params.sendData — forwards to the PTY
 * @returns {() => void} dispose
 */
export const attachDictationBridge = ({ container, textarea, sendData }) => {
  if (!container || !textarea || typeof sendData !== 'function') return () => {};

  // What the textarea held the last time we reconciled it with the PTY.
  let mirror = textarea.value || '';
  // Length of `mirror` we did not put into the PTY ourselves — see diffToTerminalInput.
  let floor = mirror.length;
  let resyncTimer = null;

  const resyncNow = () => {
    resyncTimer = null;
    mirror = textarea.value || '';
    floor = mirror.length;
  };

  // Deferred: xterm's own handler runs after ours and may clear the textarea
  // (Enter and Ctrl-C do), so read the field only once it has had its turn.
  const scheduleResync = () => {
    if (resyncTimer != null) return;
    resyncTimer = setTimeout(resyncNow, 0);
  };

  const handleKeyDown = (ev) => {
    // 229 is the "composition character" every soft keyboard/IME reports — those
    // keystrokes land in the textarea and are ours to diff, not a resync point.
    if (ev.keyCode === 229 || ev.isComposing) return;
    scheduleResync();
  };

  const handleInput = (ev) => {
    if (ev.target !== textarea) return;
    // A real composition (IME candidate window) is xterm's CompositionHelper's job;
    // it forwards the committed text on compositionend.
    if (ev.isComposing) return;
    const inputType = ev.inputType;
    if (inputType && !OWNED_INPUT_TYPES.has(inputType)) {
      resyncNow();
      return;
    }
    // Ours: stop the event before xterm's textarea listener can append the raw
    // insertion on top of what we're about to reconcile.
    ev.stopPropagation();
    const next = textarea.value || '';
    const data = diffToTerminalInput(mirror, next, floor);
    mirror = next;
    if (data) sendData(data);
  };

  container.addEventListener('keydown', handleKeyDown, true);
  container.addEventListener('input', handleInput, true);
  // blur/compositionend don't bubble, but capture-phase listeners still see them.
  container.addEventListener('blur', scheduleResync, true);
  container.addEventListener('compositionend', scheduleResync, true);

  return () => {
    if (resyncTimer != null) clearTimeout(resyncTimer);
    container.removeEventListener('keydown', handleKeyDown, true);
    container.removeEventListener('input', handleInput, true);
    container.removeEventListener('blur', scheduleResync, true);
    container.removeEventListener('compositionend', scheduleResync, true);
  };
};

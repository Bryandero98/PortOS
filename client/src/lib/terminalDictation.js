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
// Intercept textarea input events in the capture phase (on `terminal.element`, so
// we run BEFORE xterm's own listener on the textarea inside it) and forward a
// DIFF instead of the raw insertion: DEL (0x7f) for each character the field
// dropped, then whatever it gained. The textarea keeps accumulating exactly as the
// OS intends, and the PTY sees the same edits a real text field would apply.
//
// Resync points (a keystroke xterm handles itself, blur, paste, composition end)
// reset the mirror without emitting anything, because those paths send to the PTY
// through xterm and may clear the textarea out from under us.
//
// ── Boundaries ─────────────────────────────────────────────────────────────────
// Corrections are streamed live, which assumes the far end treats 0x7f as "erase
// the previous character" — true at a shell prompt and in the line editors of the
// TUIs this page drives. In a full-screen app that binds DEL to something else, a
// mid-phrase correction is as approximate as a human backspacing would be; live
// echo is worth more here than a settle-then-send buffer that hides the words the
// user is speaking. Because we stop the event before xterm sees it, xterm never
// clears the textarea mid-phrase either, so the mirror grows for as long as the
// dictation does (bounded by the next resync — Enter, Ctrl-C, or blur).

// 0x7f — what a terminal expects for "erase the previous character".
export const TERMINAL_DEL = '\x7f';

// Input events whose effect we translate into terminal input ourselves: text the
// field gained, and every flavour of text it dropped. Anything else (paste, undo,
// composition text, line breaks) is already handled by xterm or the keydown path
// and only resyncs our mirror — an unknown future `insert*` type must fall through
// to xterm rather than being double-sent by both of us.
const isOwnedInput = (inputType) => (
  !inputType
  || inputType === 'insertText'
  || inputType === 'insertReplacementText'
  || inputType.startsWith('delete')
);

const commonPrefixLength = (a, b) => {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};

/**
 * Translate a text-field edit into terminal input.
 *
 * @param {string} mirror   what the field held when we last forwarded it
 * @param {string} next     what the field holds now
 * @param {number} floor    how much of `mirror` reached the PTY some other way
 *   (typed keystrokes, a paste). We retype from the floor rather than rewinding
 *   through it, so a correction can never erase text we didn't write.
 * @returns {string} the bytes to send to the PTY ('' when nothing changed)
 */
export const diffToTerminalInput = (mirror, next, floor = 0) => {
  const rewindTo = Math.min(mirror.length, Math.max(commonPrefixLength(mirror, next), floor));
  const tail = next.slice(rewindTo);
  // Pure append is the common case — skip building an empty DEL run for it.
  return rewindTo === mirror.length ? tail : TERMINAL_DEL.repeat(mirror.length - rewindTo) + tail;
};

/**
 * Wire the dictation bridge onto a live xterm instance.
 *
 * @param {object} terminal — an xterm `Terminal`. Only its public surface is used:
 *   `element` (the container it mounted into, and an ancestor of `textarea`, so
 *   capture-phase listeners there run before xterm's own), `textarea`, `options`.
 * @param {(data: string) => boolean|void} sendData — forwards to the PTY. Return
 *   `false` to report the data was dropped (e.g. mid session-switch); the mirror
 *   then treats it as text we didn't write instead of claiming the PTY has it.
 * @returns {() => void} dispose
 */
export const attachDictationBridge = (terminal, sendData) => {
  const container = terminal?.element;
  const textarea = terminal?.textarea;
  if (!container || !textarea || typeof sendData !== 'function') return () => {};

  // What the textarea held the last time we reconciled it with the PTY.
  let mirror = textarea.value;
  // Length of `mirror` we did not put into the PTY ourselves — see diffToTerminalInput.
  let floor = mirror.length;
  let resyncTimer = null;

  const resyncNow = () => {
    resyncTimer = null;
    mirror = textarea.value;
    floor = mirror.length;
  };

  // Deferred: xterm's own handler runs after ours and may clear the textarea
  // (Enter and Ctrl-C do), so read the field only once it has had its turn.
  const scheduleResync = () => {
    // Physical typing is the hot path and leaves nothing to reconcile — xterm
    // cancels those keydowns, so the textarea stays as empty as the mirror.
    if (resyncTimer != null || (mirror === '' && textarea.value === '')) return;
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
    // Screen-reader mode is the one configuration where xterm deliberately lets
    // these events through so the textarea can be read out — stay out of the way.
    if (terminal.options?.screenReaderMode) return;
    if (!isOwnedInput(ev.inputType)) {
      resyncNow();
      return;
    }
    // Ours: stop the event before xterm's textarea listener can append the raw
    // insertion on top of what we're about to reconcile.
    ev.stopPropagation();
    const next = textarea.value;
    const data = diffToTerminalInput(mirror, next, floor);
    // A refused send leaves the PTY exactly as it was, so leave the mirror there
    // too — the next refinement then re-diffs against what the PTY really has
    // instead of erasing characters that never arrived.
    if (data && sendData(data) === false) return;
    mirror = next;
  };

  // blur/compositionend don't bubble, but capture-phase listeners still see them.
  const listeners = [
    ['keydown', handleKeyDown],
    ['input', handleInput],
    ['blur', scheduleResync],
    ['compositionend', scheduleResync],
  ];
  for (const [type, handler] of listeners) container.addEventListener(type, handler, true);

  return () => {
    clearTimeout(resyncTimer);
    for (const [type, handler] of listeners) container.removeEventListener(type, handler, true);
  };
};

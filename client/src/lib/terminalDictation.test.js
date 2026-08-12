import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { TERMINAL_DEL as DEL, planFieldEdit, attachDictationBridge } from './terminalDictation.js';

// Replay an emitted terminal-input stream the way a line editor would, so a test
// can assert "the prompt ends up holding what was dictated" rather than pinning
// the exact byte sequence that gets it there.
const render = (chunks) => chunks.join('').split('').reduce(
  (acc, ch) => (ch === DEL ? acc.slice(0, -1) : acc + ch),
  '',
);

describe('planFieldEdit', () => {
  const data = (...args) => planFieldEdit(...args).data;

  it('emits nothing when the field did not change', () => {
    expect(data('hello', 'hello')).toBe('');
  });

  it('emits only the appended text when the field grew', () => {
    expect(data('determin', 'determines')).toBe('es');
  });

  it('erases the replaced tail before retyping it', () => {
    expect(data('their', 'there')).toBe(`${DEL}${DEL}re`);
  });

  it('emits pure deletions when the field shrank', () => {
    expect(data('hello', 'hell')).toBe(DEL);
    expect(data('hello', '')).toBe(DEL.repeat(5));
  });

  it('never rewinds below the floor — it retypes instead of eating prior text', () => {
    // 'ls ' reached the PTY as keystrokes (floor 3); only 'foo' is ours.
    expect(data('ls foo', 'ls bar', 3)).toBe(`${DEL.repeat(3)}bar`);
    // Divergence below the floor: retype from the floor, delete nothing under it.
    expect(data('ls foo', 'xx bar', 3)).toBe(`${DEL.repeat(3)}bar`);
    // A floor past the end of the mirror clamps instead of emitting a negative run.
    expect(data('ab', 'abc', 99)).toBe('c');
  });

  it('reports what the PTY holds, which is not the field when the floor blocked a rewind', () => {
    // Normally the PTY ends up holding exactly what the field shows.
    expect(planFieldEdit('their', 'there').committed).toBe('there');
    // But 'ls ' is below the floor and was never rewound, so the PTY holds
    // 'ls bar' even though the field reads 'xx bar'. Tracking the field here
    // would make every later diff rewind against a baseline that never existed.
    expect(planFieldEdit('ls foo', 'xx bar', 3).committed).toBe('ls bar');
  });

  it('does not split a surrogate pair', () => {
    // 😀 and 😂 share a high surrogate; cutting between the halves would send a
    // lone surrogate, which serializes to U+FFFD instead of the emoji.
    const plan = planFieldEdit('hi 😀', 'hi 😂');
    expect(plan.data).toBe(`${DEL.repeat(2)}😂`);
    expect(plan.committed).toBe('hi 😂');
    expect([...plan.data].every((ch) => ch.charCodeAt(0) < 0xd800 || ch.codePointAt(0) > 0xffff)).toBe(true);
  });
});

describe('attachDictationBridge', () => {
  let container;
  let textarea;
  let terminal;
  let sent;
  let dispose;

  // Faithful to what a browser dispatches: dictation/soft-keyboard edits arrive
  // as InputEvents carrying inputType, and the field value is already updated.
  const fireInput = (inputType, data = null) => {
    textarea.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true }));
  };

  // Stands in for xterm's own textarea listener, which appends the raw insertion.
  const attachXtermStub = () => {
    const spy = vi.fn();
    textarea.addEventListener('input', spy);
    return spy;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    textarea = document.createElement('textarea');
    container.appendChild(textarea);
    document.body.appendChild(container);
    terminal = { element: container, textarea, options: {} };
    sent = [];
    dispose = attachDictationBridge(terminal, (d) => { sent.push(d); });
  });

  afterEach(() => {
    dispose();
    container.remove();
    vi.useRealTimers();
  });

  it('does not attach or throw when the terminal has no DOM yet', () => {
    expect(() => attachDictationBridge({}, () => {})()).not.toThrow();
    expect(() => attachDictationBridge(terminal, null)()).not.toThrow();
  });

  it('forwards a streaming dictation phrase without duplicating it', () => {
    // Exactly the reported failure: Apple dictation rewrites its own guess.
    for (const partial of ['dde', 'deter', 'determin', 'determine', 'determines', 'determines if any code']) {
      textarea.value = partial;
      fireInput('insertText');
    }
    expect(render(sent)).toBe('determines if any code');
  });

  it('stops the event before xterm can append the raw insertion', () => {
    const xterm = attachXtermStub();
    textarea.value = 'hi';
    fireInput('insertText');
    expect(xterm).not.toHaveBeenCalled();
    expect(sent).toEqual(['hi']);
  });

  it('translates a dictation replacement into erase + retype', () => {
    textarea.value = 'their';
    fireInput('insertText');
    textarea.value = 'there';
    fireInput('insertReplacementText');
    expect(sent).toEqual(['their', `${DEL}${DEL}re`]);
  });

  it('forwards soft-keyboard deletions', () => {
    textarea.value = 'abc';
    fireInput('insertText');
    textarea.value = 'ab';
    fireInput('deleteContentBackward');
    textarea.value = '';
    fireInput('deleteWordBackward');
    expect(sent).toEqual(['abc', DEL, DEL.repeat(2)]);
  });

  it('leaves unowned input types to xterm and resyncs the mirror', () => {
    const xterm = attachXtermStub();
    textarea.value = 'pasted';
    fireInput('insertFromPaste');
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
    // The paste is now part of the untouchable floor: a later dictation appends
    // rather than erasing text xterm already sent.
    textarea.value = 'pasted more';
    fireInput('insertText');
    expect(sent).toEqual([' more']);
  });

  it('ignores input that belongs to an in-progress composition', () => {
    const xterm = attachXtermStub();
    textarea.value = 'か';
    textarea.dispatchEvent(new InputEvent('input', {
      inputType: 'insertCompositionText', data: 'か', isComposing: true, bubbles: true,
    }));
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way in screen-reader mode', () => {
    const xterm = attachXtermStub();
    terminal.options.screenReaderMode = true;
    textarea.value = 'abc';
    fireInput('insertText');
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
  });

  it('does not claim text the sink reports as dropped', () => {
    dispose();
    let delivered = false;
    dispose = attachDictationBridge(terminal, (d) => { if (delivered) sent.push(d); return delivered; });
    // Mid session-switch: the emit is refused, so the PTY never saw 'abc'.
    textarea.value = 'abc';
    fireInput('insertText');
    delivered = true;
    // Once sends land again the whole phrase goes out — no DELs for characters
    // that never arrived, and no silently swallowed words.
    textarea.value = 'abd';
    fireInput('insertReplacementText');
    expect(sent).toEqual(['abd']);
  });

  it('resyncs after a keystroke xterm handles itself', () => {
    textarea.value = 'abc';
    fireInput('insertText');
    // Enter: xterm sends CR and clears the textarea.
    textarea.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    textarea.value = '';
    vi.runAllTimers();
    // Next dictation starts from a clean mirror — no phantom DELs for 'abc'.
    textarea.value = 'next';
    fireInput('insertText');
    expect(sent).toEqual(['abc', 'next']);
  });

  it('does not resync on the composition keycode soft keyboards report', () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 229, bubbles: true }));
    textarea.value = 'ab';
    fireInput('insertText');
    vi.runAllTimers();
    textarea.value = 'abc';
    fireInput('insertText');
    expect(sent).toEqual(['ab', 'c']);
  });

  it('resyncs on blur, which clears xterm\'s textarea', () => {
    textarea.value = 'abc';
    fireInput('insertText');
    textarea.dispatchEvent(new FocusEvent('blur'));
    textarea.value = '';
    vi.runAllTimers();
    textarea.value = 'fresh';
    fireInput('insertText');
    expect(sent).toEqual(['abc', 'fresh']);
  });

  it('cancels a pending resync when it reconciles the field itself', () => {
    // A keystroke xterm handled arms a resync; the dictation event that follows
    // reconciles the field first. If the stale timer still fired it would pin the
    // floor to the whole phrase and silently swallow every later correction.
    textarea.value = 'their';
    fireInput('insertText');
    // Field is non-empty now, so this keystroke really does arm a resync.
    textarea.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 32, bubbles: true }));
    textarea.value = 'there';
    fireInput('insertReplacementText');
    vi.runAllTimers();
    // A stale resync would have pinned floor to 'there'.length, and this
    // correction would emit nothing at all.
    textarea.value = 'their';
    fireInput('insertReplacementText');
    expect(sent).toEqual(['their', `${DEL}${DEL}re`, `${DEL}${DEL}ir`]);
  });

  it('arms no timer while typing leaves nothing to reconcile', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    textarea.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 65, bubbles: true }));
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });

  it('detaches every listener on dispose', () => {
    dispose();
    const xterm = attachXtermStub();
    textarea.value = 'after';
    fireInput('insertText');
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
  });
});

// The bridge's whole seam is "our capture-phase listener on terminal.element runs
// before xterm's own listener on the textarea inside it". The stub above can't
// prove that — only a real Terminal can, and this is what fails loudly if an
// xterm upgrade moves or re-phases that listener.
describe('attachDictationBridge against a real xterm Terminal', () => {
  let container;
  let terminal;

  beforeEach(() => {
    // xterm reads the device pixel ratio on open(); jsdom ships no matchMedia.
    window.matchMedia = vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} }));
    container = document.createElement('div');
    document.body.appendChild(container);
    terminal = new Terminal({ allowProposedApi: true });
    terminal.open(container);
  });

  afterEach(() => {
    terminal.dispose();
    container.remove();
    delete window.matchMedia;
  });

  // Each refinement replaces the field's whole contents, which is what Apple
  // dictation does — `data` carries the text the field gained, exactly the value
  // xterm's own handler forwards verbatim.
  const dictate = (partials) => {
    for (const partial of partials) {
      terminal.textarea.value = partial;
      terminal.textarea.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: partial, bubbles: true,
      }));
    }
  };

  // The bug, pinned upstream. If a future @xterm/xterm starts reconciling these
  // events itself this fails — at which point the bridge is double-handling and
  // should go, rather than quietly fighting xterm for the same input.
  it('garbles the phrase when xterm handles the events alone', () => {
    const sent = [];
    terminal.onData((d) => sent.push(d));
    dictate(['dde', 'deter', 'determin', 'determine', 'determines']);
    expect(sent.join('')).toBe('ddedeterdetermindeterminedetermines');
  });

  it('sends the dictated phrase once, not the accumulated garble', () => {
    const sent = [];
    // onData is where xterm's own textarea handling would surface, so anything it
    // forwards behind our back shows up here too.
    terminal.onData((d) => sent.push(d));
    const dispose = attachDictationBridge(terminal, (d) => { sent.push(d); });
    dictate(['dde', 'deter', 'determin', 'determine', 'determines']);
    dispose();

    expect(render(sent)).toBe('determines');
  });
});

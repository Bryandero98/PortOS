import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEL, commonPrefixLength, diffToTerminalInput, attachDictationBridge } from './terminalDictation.js';

describe('commonPrefixLength', () => {
  it('counts the shared leading characters', () => {
    expect(commonPrefixLength('determin', 'determines')).toBe(8);
    expect(commonPrefixLength('abc', 'abc')).toBe(3);
    expect(commonPrefixLength('abc', 'xyz')).toBe(0);
    expect(commonPrefixLength('', 'abc')).toBe(0);
  });
});

describe('diffToTerminalInput', () => {
  it('emits nothing when the field did not change', () => {
    expect(diffToTerminalInput('hello', 'hello')).toBe('');
  });

  it('emits only the appended text when the field grew', () => {
    expect(diffToTerminalInput('determin', 'determines')).toBe('es');
  });

  it('erases the replaced tail before retyping it', () => {
    // The dictation case: the field replaced "termine" with "termines".
    expect(diffToTerminalInput('determine', 'determined')).toBe('d');
    expect(diffToTerminalInput('their', 'there')).toBe(`${DEL}${DEL}re`);
  });

  it('emits pure deletions when the field shrank', () => {
    expect(diffToTerminalInput('hello', 'hell')).toBe(DEL);
    expect(diffToTerminalInput('hello', '')).toBe(DEL.repeat(5));
  });

  it('never rewinds below the floor — it retypes instead of eating prior text', () => {
    // 'ls ' reached the PTY as keystrokes (floor 3); only 'foo' is ours.
    expect(diffToTerminalInput('ls foo', 'ls bar', 3)).toBe(`${DEL.repeat(3)}bar`);
    // Divergence below the floor: retype from the floor, delete nothing under it.
    expect(diffToTerminalInput('ls foo', 'xx bar', 3)).toBe(`${DEL.repeat(3)}bar`);
  });

  it('clamps a floor longer than the mirror', () => {
    expect(diffToTerminalInput('ab', 'abc', 99)).toBe('c');
  });
});

describe('attachDictationBridge', () => {
  let container;
  let textarea;
  let sent;
  let dispose;

  const fireInput = (inputType) => {
    const ev = new Event('input', { bubbles: true });
    // jsdom has no InputEvent#inputType on a plain Event — set it explicitly.
    Object.defineProperty(ev, 'inputType', { value: inputType });
    textarea.dispatchEvent(ev);
    return ev;
  };

  // Stands in for xterm's own textarea listener, which appends the raw insertion.
  const attachXtermStub = () => {
    const spy = vi.fn();
    textarea.addEventListener('input', spy, true);
    return spy;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    textarea = document.createElement('textarea');
    container.appendChild(textarea);
    document.body.appendChild(container);
    sent = [];
    dispose = attachDictationBridge({ container, textarea, sendData: (d) => sent.push(d) });
  });

  afterEach(() => {
    dispose();
    container.remove();
    vi.useRealTimers();
  });

  it('is a no-op when wired with missing pieces', () => {
    expect(attachDictationBridge({})()).toBeUndefined();
    expect(attachDictationBridge({ container, textarea })()).toBeUndefined();
  });

  it('forwards a streaming dictation phrase without duplicating it', () => {
    // Exactly the reported failure: Apple dictation rewrites its own guess.
    for (const partial of ['dde', 'deter', 'determin', 'determine', 'determines', 'determines if any code']) {
      textarea.value = partial;
      fireInput('insertText');
    }
    // Replaying the emitted stream through a terminal-ish reducer must reproduce
    // the field's final value — not the accumulated garble.
    const rendered = sent.join('').split('').reduce((acc, ch) => (ch === DEL ? acc.slice(0, -1) : acc + ch), '');
    expect(rendered).toBe('determines if any code');
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
    expect(sent).toEqual(['abc', DEL]);
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
    const ev = new Event('input', { bubbles: true });
    Object.defineProperty(ev, 'inputType', { value: 'insertCompositionText' });
    Object.defineProperty(ev, 'isComposing', { value: true });
    textarea.value = 'か';
    textarea.dispatchEvent(ev);
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
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

  it('detaches every listener on dispose', () => {
    dispose();
    const xterm = attachXtermStub();
    textarea.value = 'after';
    fireInput('insertText');
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import useKeyCapture from './useKeyCapture';
import { installVoiceHotkeySpy } from '../test/voiceHotkeySpy.js';

// The whole point of this hook is that a claimed key never reaches an
// app-global bubble-phase listener — that is what keeps the voice widget's
// Space push-to-talk hotkey from firing during a Space-driven drill. Every test
// here installs a stand-in for that global listener and asserts on it.

function Probe({ enabled = true, enabledInDialog = false, onKeyDown, onKeyUp }) {
  useKeyCapture({ enabled, enabledInDialog, onKeyDown, onKeyUp });
  return (
    <>
      <input aria-label="note" />
      {/* Every claiming surface renders its own buttons — a drill's Start/Match,
          RapidReader's transport, the keyer's mode switches. */}
      <button type="button">act</button>
    </>
  );
}

// A stand-in for whatever dialog is on top — Modal and Drawer both render this
// attribute, and the hook consults it, not either component.
function openDialog() {
  const dialog = document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  document.body.appendChild(dialog);
  return () => dialog.remove();
}

afterEach(cleanup);

describe('useKeyCapture', () => {
  // This hook claims both halves of a press, so the stand-in voice hotkey spies
  // on keyup too.
  const voiceHotkey = installVoiceHotkeySpy({ keyup: true });
  const withGlobalHotkey = (fn) => fn(voiceHotkey());

  it('hides a claimed key from an app-global bubble listener', () => {
    const claimed = vi.fn(() => true);
    render(<Probe onKeyDown={claimed} />);
    withGlobalHotkey((global) => {
      fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
      expect(claimed).toHaveBeenCalledTimes(1);
      expect(global).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['an explicit false', false],
    // A handler that forgets to return still must not swallow the key.
    ['a forgotten return', undefined],
  ])('lets a key through to the global listener on %s', (_label, verdict) => {
    render(<Probe onKeyDown={() => verdict} />);
    withGlobalHotkey((global) => {
      fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
      expect(global).toHaveBeenCalledTimes(1);
    });
  });

  it('never offers events that originate in a text field', () => {
    const claimed = vi.fn(() => true);
    const { getByLabelText } = render(<Probe onKeyDown={claimed} />);
    withGlobalHotkey((global) => {
      fireEvent.keyDown(getByLabelText('note'), { code: 'Space', key: ' ' });
      expect(claimed).not.toHaveBeenCalled();
      expect(global).toHaveBeenCalledTimes(1);
    });
  });

  it('claims keyup independently of keydown', () => {
    const up = vi.fn(() => true);
    render(<Probe onKeyDown={() => false} onKeyUp={up} />);
    withGlobalHotkey((global) => {
      fireEvent.keyUp(document.body, { code: 'Space', key: ' ' });
      expect(up).toHaveBeenCalledTimes(1);
      expect(global).not.toHaveBeenCalled();
    });
  });

  it('detaches while disabled so the global hotkey works again', () => {
    const claimed = vi.fn(() => true);
    render(<Probe enabled={false} onKeyDown={claimed} />);
    withGlobalHotkey((global) => {
      fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
      expect(claimed).not.toHaveBeenCalled();
      expect(global).toHaveBeenCalledTimes(1);
    });
  });

  it('stops listening after unmount', () => {
    const claimed = vi.fn(() => true);
    const { unmount } = render(<Probe onKeyDown={claimed} />);
    unmount();
    withGlobalHotkey((global) => {
      fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
      expect(claimed).not.toHaveBeenCalled();
      expect(global).toHaveBeenCalledTimes(1);
    });
  });

  it('stands down while a dialog is open, so that layer owns the key', () => {
    const claimed = vi.fn(() => true);
    render(<Probe onKeyDown={claimed} />);
    const close = openDialog();
    withGlobalHotkey((global) => {
      fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
      expect(claimed).not.toHaveBeenCalled();
      expect(global).toHaveBeenCalledTimes(1);
    });
    close();
  });

  it('keeps claiming inside a dialog when the surface opts in', () => {
    const claimed = vi.fn(() => true);
    render(<Probe enabledInDialog onKeyDown={claimed} />);
    const close = openDialog();
    withGlobalHotkey((global) => {
      fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
      expect(claimed).toHaveBeenCalledTimes(1);
      expect(global).not.toHaveBeenCalled();
    });
    close();
  });

  it('subscribes no keyup listener when the caller passes no onKeyUp', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    render(<Probe onKeyDown={() => true} />);
    const captured = addSpy.mock.calls.filter(([, , capture]) => capture === true).map(([type]) => type);
    expect(captured).toEqual(['keydown']);
    addSpy.mockRestore();
  });

  // Space on a focused button must PRESS IT, not run the claimed action — the
  // same stand-down the voice widget and useKeyboardShortcuts already performed
  // before the guard was shared (#4748).
  it('never claims Space on a focused button, so the browser still activates it', () => {
    const claimed = vi.fn(() => true);
    const activated = vi.fn();
    const { getByRole } = render(<Probe onKeyDown={claimed} onKeyUp={claimed} />);
    const button = getByRole('button', { name: 'act' });
    button.addEventListener('click', activated);
    withGlobalHotkey((global) => {
      fireEvent.keyDown(button, { code: 'Space', key: ' ' });
      fireEvent.keyUp(button, { code: 'Space', key: ' ' });
      expect(claimed).not.toHaveBeenCalled();
      // Unclaimed means un-preventDefault-ed, so the press reaches the browser
      // (jsdom does not synthesize the activation click, hence the explicit
      // click below standing in for it) and window like any other key.
      expect(global).toHaveBeenCalledTimes(2);
      fireEvent.click(button);
      expect(activated).toHaveBeenCalledTimes(1);
    });
  });

  it('still claims a non-Space key pressed on a focused button', () => {
    const claimed = vi.fn(() => true);
    const { getByRole } = render(<Probe onKeyDown={claimed} />);
    withGlobalHotkey((global) => {
      fireEvent.keyDown(getByRole('button', { name: 'act' }), { code: 'Enter', key: 'Enter' });
      expect(claimed).toHaveBeenCalledTimes(1);
      expect(global).not.toHaveBeenCalled();
    });
  });

  // Unlike useKeyboardShortcuts, a claiming surface reads a raw physical key and
  // tracks press/release itself: a dropped repeat leaves a held Space scrolling
  // the page, a dropped chord strands a keydown with no matching keyup.
  it.each([
    ['an auto-repeat keydown', { repeat: true }],
    ['a modifier chord', { ctrlKey: true }],
  ])('still offers %s', (_label, extra) => {
    const claimed = vi.fn(() => true);
    render(<Probe onKeyDown={claimed} />);
    withGlobalHotkey((global) => {
      fireEvent.keyDown(document.body, { code: 'Space', key: ' ', ...extra });
      expect(claimed).toHaveBeenCalledTimes(1);
      expect(global).not.toHaveBeenCalled();
    });
  });

  // A press that was claimed must always be RELEASED, or a handler that began
  // something on the keydown (the Morse keyer's tone) is stranded. The guards
  // read state that can change while a key is held — focus moving onto a button,
  // a dialog opening — so the keyup mirrors the keydown's decision instead of
  // re-asking.
  it('releases a claimed press even when focus moves to a button mid-hold', () => {
    const down = vi.fn(() => true);
    const up = vi.fn(() => true);
    const { getByRole } = render(<Probe onKeyDown={down} onKeyUp={up} />);

    fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
    expect(down).toHaveBeenCalledTimes(1);

    // Focus lands on a button while Space is still held, so the release arrives
    // with a button target.
    fireEvent.keyUp(getByRole('button', { name: 'act' }), { code: 'Space', key: ' ' });
    expect(up).toHaveBeenCalledTimes(1);
  });

  it('does not release a press it never claimed', () => {
    const down = vi.fn(() => true);
    const up = vi.fn(() => true);
    const { getByRole } = render(<Probe onKeyDown={down} onKeyUp={up} />);
    const button = getByRole('button', { name: 'act' });

    // Both halves on the button: the browser owns this press end to end, and
    // activating a <button> fires on the KEYUP — claiming it would cancel that.
    fireEvent.keyDown(button, { code: 'Space', key: ' ' });
    fireEvent.keyUp(button, { code: 'Space', key: ' ' });

    expect(down).not.toHaveBeenCalled();
    expect(up).not.toHaveBeenCalled();
  });

  it('reads the latest handler without re-subscribing', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const { rerender } = render(<Probe onKeyDown={first} />);
    rerender(<Probe onKeyDown={second} />);
    fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

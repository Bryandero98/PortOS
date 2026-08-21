import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import useKeyCapture from './useKeyCapture';

// The whole point of this hook is that a claimed key never reaches an
// app-global bubble-phase listener — that is what keeps the voice widget's
// Space push-to-talk hotkey from firing during a Space-driven drill. Every test
// here installs a stand-in for that global listener and asserts on it.

function Probe({ enabled = true, onKeyDown, onKeyUp }) {
  useKeyCapture({ enabled, onKeyDown, onKeyUp });
  return <input aria-label="note" />;
}

function withGlobalHotkey(fn) {
  const global = vi.fn();
  window.addEventListener('keydown', global);
  window.addEventListener('keyup', global);
  try {
    return fn(global);
  } finally {
    window.removeEventListener('keydown', global);
    window.removeEventListener('keyup', global);
  }
}

afterEach(cleanup);

describe('useKeyCapture', () => {
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

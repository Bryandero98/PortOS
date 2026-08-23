import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import useKeyboardControls from './useKeyboardControls';

// The hook hands back the live held-key Set the OpenWorld rig reads every frame, so the
// assertions here are about what does and does not end up in that Set.
const keys = { current: null };

function Probe({ onToggleMode }) {
  keys.current = useKeyboardControls(onToggleMode);
  return <input aria-label="search" />;
}

function openDialog() {
  const dialog = document.createElement('div');
  dialog.setAttribute('aria-modal', 'true');
  document.body.appendChild(dialog);
  return () => dialog.remove();
}

afterEach(cleanup);

describe('useKeyboardControls', () => {
  it('records a held movement key and clears it on release', () => {
    render(<Probe />);

    fireEvent.keyDown(document.body, { key: 'W' });
    expect(keys.current.current.has('w')).toBe(true);

    fireEvent.keyUp(document.body, { key: 'W' });
    expect(keys.current.current.has('w')).toBe(false);
  });

  it('clears the released key even for a Space claimed by a capture-phase listener', () => {
    // PlayerController claims the Space keydown (so the voice hotkey never sees it) and
    // adds ' ' itself, then relies on THIS listener to clear it — it binds no keyup.
    render(<Probe />);
    keys.current.current.add(' ');

    fireEvent.keyUp(document.body, { key: ' ' });

    expect(keys.current.current.has(' ')).toBe(false);
  });

  it('ignores keys typed into a form field', () => {
    const { getByLabelText } = render(<Probe />);

    fireEvent.keyDown(getByLabelText('search'), { key: 'w' });

    expect(keys.current.current.has('w')).toBe(false);
  });

  it('ignores movement while a dialog is open, so the rig stays put behind it', () => {
    render(<Probe />);
    const close = openDialog();

    fireEvent.keyDown(document.body, { key: ' ' });
    fireEvent.keyDown(document.body, { key: 'w' });

    expect(keys.current.current.has(' ')).toBe(false);
    expect(keys.current.current.has('w')).toBe(false);
    close();
  });

  it('toggles exploration mode on Tab', () => {
    const onToggleMode = vi.fn();
    render(<Probe onToggleMode={onToggleMode} />);

    fireEvent.keyDown(document.body, { key: 'Tab' });

    expect(onToggleMode).toHaveBeenCalledTimes(1);
    expect(keys.current.current.has('tab')).toBe(false);
  });

  it('leaves Tab alone in a form field and behind a dialog, where it must move focus', () => {
    const onToggleMode = vi.fn();
    const { getByLabelText } = render(<Probe onToggleMode={onToggleMode} />);

    fireEvent.keyDown(getByLabelText('search'), { key: 'Tab' });
    const close = openDialog();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    close();

    expect(onToggleMode).not.toHaveBeenCalled();
  });

  it('drops every held key when the window loses focus', () => {
    render(<Probe />);
    fireEvent.keyDown(document.body, { key: 'w' });

    fireEvent.blur(window);

    expect(keys.current.current.size).toBe(0);
  });
});

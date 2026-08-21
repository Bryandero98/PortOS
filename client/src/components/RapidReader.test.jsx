import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import RapidReader from './RapidReader';

describe('RapidReader keyboard transport', () => {
  // Stands in for VoiceWidget's app-global push-to-talk hotkey, which binds the same
  // Space on `window` in the bubble phase. The reader claims its keys in the capture
  // phase, so a handled key must never reach this spy.
  let voiceHotkey;

  beforeEach(() => {
    voiceHotkey = vi.fn();
    window.addEventListener('keydown', voiceHotkey);
  });

  afterEach(() => {
    window.removeEventListener('keydown', voiceHotkey);
  });

  const renderReader = (props = {}) => render(
    <RapidReader text="alpha bravo charlie delta" chunkSize={1} {...props} />,
  );

  it('toggles play on Space without leaking the key to the global voice hotkey', () => {
    renderReader();
    expect(screen.getByLabelText('Play')).toBeInTheDocument();

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Pause')).toBeInTheDocument();
    expect(voiceHotkey).not.toHaveBeenCalled();
  });

  it('claims Escape for its own close handler', () => {
    const onClose = vi.fn();
    renderReader({ onClose });

    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(voiceHotkey).not.toHaveBeenCalled();
  });

  it('lets unhandled keys through to app-global listeners', () => {
    renderReader();

    act(() => { fireEvent.keyDown(document.body, { key: 'j' }); });

    expect(voiceHotkey).toHaveBeenCalledTimes(1);
  });

  it('ignores keys typed into a text field', () => {
    const { container } = renderReader();
    const input = document.createElement('input');
    container.appendChild(input);

    act(() => { fireEvent.keyDown(input, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  it('ignores Space aimed at a <select>, where it natively opens the dropdown', () => {
    // The old hand-rolled guard only knew INPUT/TEXTAREA/contentEditable, so Space on a
    // focused <select> hijacked the transport. `isEditableTarget` covers SELECT.
    const { container } = renderReader();
    const select = document.createElement('select');
    container.appendChild(select);

    act(() => { fireEvent.keyDown(select, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  it('steps through the text with the arrow keys', () => {
    // The current word is split across spans to anchor its focal letter, so the
    // token counter ("2/4") is the readable signal for which word is showing.
    const { container } = renderReader();
    const position = () => container.querySelector('.font-mono.text-gray-500').textContent.split(' ')[0];
    expect(position()).toBe('1/4');

    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }); });
    expect(position()).toBe('2/4');

    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft' }); });
    expect(position()).toBe('1/4');
    expect(voiceHotkey).not.toHaveBeenCalled();
  });
});

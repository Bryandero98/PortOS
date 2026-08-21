import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { installVoiceHotkeySpy } from '../test/voiceHotkeySpy';
import RapidReader, { RapidReaderModal } from './RapidReader';

describe('RapidReader keyboard transport', () => {
  const voiceHotkey = installVoiceHotkeySpy();

  const renderReader = (props = {}) => render(
    <RapidReader text="alpha bravo charlie delta" chunkSize={1} {...props} />,
  );

  it('toggles play on Space without leaking the key to the global voice hotkey', () => {
    renderReader();
    expect(screen.getByLabelText('Play')).toBeInTheDocument();

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Pause')).toBeInTheDocument();
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('claims Escape for its own close handler', () => {
    const onClose = vi.fn();
    renderReader({ onClose });

    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('ignores Space aimed at a <select>, where it natively opens the dropdown', () => {
    // The old hand-rolled guard only knew INPUT/TEXTAREA/contentEditable, so Space on a
    // <select> hijacked the transport. `isEditableTarget` covers SELECT.
    const { container } = renderReader();
    const select = document.createElement('select');
    container.appendChild(select);

    act(() => { fireEvent.keyDown(select, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  it('steps through the text with the arrow keys', () => {
    // The current word is split across spans to anchor its focal letter, so the token
    // counter ("2/4") is the readable signal for which word is showing.
    const { container } = renderReader();
    expect(container.textContent).toContain('1/4');

    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }); });
    expect(container.textContent).toContain('2/4');

    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft' }); });
    expect(container.textContent).toContain('1/4');
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('stands down while an unrelated dialog is open', () => {
    const { container } = renderReader();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    container.appendChild(dialog);

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  it('keeps its keys inside RapidReaderModal, whose own Modal is that dialog', () => {
    render(<RapidReaderModal open text="alpha bravo charlie delta" title="Notes" onClose={vi.fn()} />);

    // autoPlay is on in the modal, so the first Space pauses.
    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(screen.getByLabelText('Play')).toBeInTheDocument();
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });
});

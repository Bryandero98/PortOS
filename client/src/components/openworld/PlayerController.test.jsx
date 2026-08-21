import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import * as THREE from 'three';
import { installVoiceHotkeySpy } from '../../test/voiceHotkeySpy';

// PlayerController is an r3f component, but its Space handling is plain DOM wiring. The
// fiber hooks are stubbed so it can mount in jsdom without a WebGL canvas; rendering in
// first-person camera mode returns null, so nothing three.js-specific ever paints.
vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: new THREE.PerspectiveCamera(), gl: { domElement: document.createElement('canvas') } }),
  useFrame: () => {},
}));

const PlayerController = (await import('./PlayerController')).default;

describe('PlayerController Space (jump) capture', () => {
  const voiceHotkey = installVoiceHotkeySpy();
  let keysRef;

  beforeEach(() => { keysRef = { current: new Set() }; });

  const renderRig = (props = {}) => render(
    <PlayerController keysRef={keysRef} active cameraView="first" positions={new Map()} apps={[]} {...props} />,
  );

  it('holds the jump key without leaking Space to the global voice hotkey', () => {
    renderRig();

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(keysRef.current.has(' ')).toBe(true);
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('ignores Space typed into a text field', () => {
    // The old guard read document.activeElement, so an un-focused field did not
    // suppress the jump; the shared isEditableTarget reads the event target.
    const { container } = renderRig();
    const input = document.createElement('input');
    container.appendChild(input);

    act(() => { fireEvent.keyDown(input, { key: ' ', code: 'Space' }); });

    expect(keysRef.current.has(' ')).toBe(false);
  });

  it('stands down while a dialog is open, so Space can activate its buttons', () => {
    const { container } = renderRig();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    container.appendChild(dialog);

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(keysRef.current.has(' ')).toBe(false);
    expect(voiceHotkey()).toHaveBeenCalledTimes(1);
  });

  it('drops a held jump when exploration mode ends', () => {
    const { rerender } = renderRig();
    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });
    expect(keysRef.current.has(' ')).toBe(true);

    act(() => {
      rerender(
        <PlayerController keysRef={keysRef} active={false} cameraView="first" positions={new Map()} apps={[]} />,
      );
    });

    expect(keysRef.current.has(' ')).toBe(false);
  });

  it('binds nothing while exploration mode is off', () => {
    renderRig({ active: false });

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(keysRef.current.has(' ')).toBe(false);
    expect(voiceHotkey()).toHaveBeenCalledTimes(1);
  });
});

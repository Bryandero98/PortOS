import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FilePickerButton from './FilePickerButton';

const pick = (input, files) => {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
};

const file = (name) => new File(['x'], name, { type: 'image/png' });

describe('FilePickerButton', () => {
  it('renders a label bound to the file input so the picker opens natively', () => {
    render(<FilePickerButton onChange={vi.fn()} ariaLabel="Add screenshots">Screenshot</FilePickerButton>);
    const input = screen.getByLabelText('Add screenshots');
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('file');
    // The visible trigger must be a <label for> pointing at the input — a
    // programmatic .click() on a hidden input is what breaks in WebKit/PWA.
    const label = screen.getByText('Screenshot');
    expect(label.tagName).toBe('LABEL');
    expect(label.getAttribute('for')).toBe(input.id);
  });

  it('keeps the input reachable by keyboard and assistive tech', () => {
    render(<FilePickerButton onChange={vi.fn()} ariaLabel="Add screenshots">Screenshot</FilePickerButton>);
    const input = screen.getByLabelText('Add screenshots');
    expect(input.getAttribute('aria-hidden')).toBeNull();
    expect(input.getAttribute('tabindex')).toBeNull();
  });

  it('passes accept/multiple through to the input', () => {
    render(<FilePickerButton onChange={vi.fn()} accept="image/*" multiple ariaLabel="Pick">Pick</FilePickerButton>);
    const input = screen.getByLabelText('Pick');
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.multiple).toBe(true);
  });

  it('clears the input after a sync handler so the same file can be re-picked', () => {
    const onChange = vi.fn();
    render(<FilePickerButton onChange={onChange} ariaLabel="Pick">Pick</FilePickerButton>);
    const input = screen.getByLabelText('Pick');
    pick(input, [file('a.png')]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
  });

  it('waits for an async handler to settle before clearing the input', async () => {
    let release;
    const seen = [];
    const onChange = vi.fn((e) => new Promise((resolve) => {
      release = () => { seen.push(e.target.files.length); resolve(); };
    }));
    render(<FilePickerButton onChange={onChange} multiple ariaLabel="Pick">Pick</FilePickerButton>);
    const input = screen.getByLabelText('Pick');
    pick(input, [file('a.png'), file('b.png')]);
    // Still readable mid-flight — clearing `value` would empty `files`.
    release();
    await Promise.resolve();
    expect(seen).toEqual([2]);
  });

  it('clears the input on a rejecting handler without an unhandled rejection', () => {
    // The wrapper is the only consumer of the handler's promise, so it must
    // settle both outcomes — letting the rejection escape would surface as an
    // unhandled rejection in the browser console (and fail the client suite).
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const onChange = vi.fn(() => Promise.reject(new Error('nope')));
    render(<FilePickerButton onChange={onChange} ariaLabel="Pick">Pick</FilePickerButton>);
    const input = screen.getByLabelText('Pick');
    pick(input, [file('a.png')]);
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
      expect(input.value).toBe('');
    });
  });

  it('disables the input and blocks pointer events on the label when disabled', () => {
    render(<FilePickerButton onChange={vi.fn()} disabled ariaLabel="Pick">Pick</FilePickerButton>);
    expect(screen.getByLabelText('Pick').disabled).toBe(true);
    expect(screen.getByText('Pick').className).toContain('pointer-events-none');
  });

  it('gives each instance a distinct input id so labels do not cross-wire', () => {
    render(
      <>
        <FilePickerButton onChange={vi.fn()} ariaLabel="First">One</FilePickerButton>
        <FilePickerButton onChange={vi.fn()} ariaLabel="Second">Two</FilePickerButton>
      </>
    );
    expect(screen.getByLabelText('First').id).not.toBe(screen.getByLabelText('Second').id);
  });
});

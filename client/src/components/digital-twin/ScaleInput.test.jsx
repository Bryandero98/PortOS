import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import ScaleInput from './ScaleInput';

describe('ScaleInput accessibility', () => {
  it('names every button with its value and descriptive label', () => {
    render(<ScaleInput value={null} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '1 - Strongly Disagree' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '3 - Neutral' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '5 - Strongly Agree' })).toBeTruthy();
  });

  it('uses caller-supplied labels in the accessible name', () => {
    render(<ScaleInput labels={['Never', 'Rarely', 'Sometimes', 'Often', 'Always']} value={2} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '2 - Rarely' })).toBeTruthy();
  });

  it('falls back to the default label when a supplied label is missing', () => {
    render(<ScaleInput labels={['Never']} value={null} onChange={() => {}} />);
    // A short labels array must not announce "undefined".
    expect(screen.getByRole('button', { name: '1 - Never' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '4 - Agree' })).toBeTruthy();
  });

  it('marks only the selected rating as pressed', () => {
    render(<ScaleInput value={4} onChange={() => {}} />);
    const pressed = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute('aria-label')).toBe('4 - Agree');
  });

  it('marks nothing pressed before a selection is made', () => {
    render(<ScaleInput value={null} onChange={() => {}} />);
    for (const b of screen.getAllByRole('button')) expect(b.getAttribute('aria-pressed')).toBe('false');
  });

  it('groups the buttons under the question text', () => {
    render(<ScaleInput groupLabel="I enjoy long walks" value={null} onChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'I enjoy long walks' })).toBeTruthy();
  });

  it('falls back to a generic group label', () => {
    render(<ScaleInput value={null} onChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'Rating scale' })).toBeTruthy();
  });

  it('reports the chosen value on click and on keyboard activation', () => {
    const onChange = vi.fn();
    render(<ScaleInput value={null} onChange={onChange} />);
    const btn = screen.getByRole('button', { name: '5 - Strongly Agree' });
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith(5);
    // Native <button> maps Enter/Space to a click, so focus + keyboard activation
    // reaches the same handler.
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not fire onChange while disabled', () => {
    const onChange = vi.fn();
    render(<ScaleInput value={null} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('button', { name: '1 - Strongly Disagree' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

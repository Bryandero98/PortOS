import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GalleryPickButton from './GalleryPickButton';

describe('GalleryPickButton', () => {
  it('invites a first pick when the slot is empty', () => {
    const onClick = vi.fn();
    render(<GalleryPickButton label="Source image" onClick={onClick} />);
    const btn = screen.getByLabelText('Source image — pick from gallery');
    expect(btn.textContent).toMatch(/Pick from gallery/i);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('offers a swap when the slot is filled, with the accessible name tracking the copy', () => {
    // WCAG 2.5.3 — a voice-control user says the words they can see, so the
    // aria-label must flip along with the visible label.
    render(<GalleryPickButton label="Keyframe 3" filled onClick={vi.fn()} />);
    const btn = screen.getByLabelText('Keyframe 3 — change image');
    expect(btn.textContent).toMatch(/Change image/i);
    expect(screen.queryByLabelText('Keyframe 3 — pick from gallery')).toBeNull();
  });
});

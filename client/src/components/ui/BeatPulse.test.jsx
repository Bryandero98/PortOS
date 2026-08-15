import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import BeatPulse from './BeatPulse.jsx';

// The dots are aria-hidden, so read them off the container rather than by role.
const dotsOf = (container) => Array.from(container.querySelectorAll('span'));

describe('BeatPulse', () => {
  it('renders one dot per beat of the bar', () => {
    const { container } = render(<BeatPulse beatsPerBar={7} beat={null} />);
    expect(dotsOf(container)).toHaveLength(7);
  });

  it('lights only the current beat, in the running tone', () => {
    const { container } = render(<BeatPulse beatsPerBar={4} beat={3} />);
    const dots = dotsOf(container);
    expect(dots[2].className).toContain('bg-port-success');
    expect(dots[2].className).toContain('scale-125');
    // Every other dot stays inert.
    [0, 1, 3].forEach((i) => {
      expect(dots[i].className).toContain('bg-port-border');
      expect(dots[i].className).not.toContain('bg-port-success');
    });
  });

  it('lights a count-in beat amber instead of green', () => {
    const { container } = render(<BeatPulse beatsPerBar={4} beat={2} countingIn />);
    const dots = dotsOf(container);
    expect(dots[1].className).toContain('bg-port-warning');
    expect(dots[1].className).not.toContain('bg-port-success');
  });

  it('draws the downbeat a size larger than the rest', () => {
    const { container } = render(<BeatPulse beatsPerBar={3} beat={null} />);
    const dots = dotsOf(container);
    expect(dots[0].className).toContain('w-3 h-3');
    expect(dots[1].className).toContain('w-2 h-2');
    expect(dots[2].className).toContain('w-2 h-2');
  });

  it('leaves every dot unlit when stopped', () => {
    const { container } = render(<BeatPulse beatsPerBar={4} beat={null} />);
    dotsOf(container).forEach((dot) => expect(dot.className).toContain('bg-port-border'));
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Stopped');
  });

  it.each([
    ['stopped', { beat: null, countingIn: false }, 'Stopped'],
    ['running', { beat: 3, countingIn: false }, 'Beat 3'],
    ['counting in', { beat: 2, countingIn: true }, 'Counting in, beat 2'],
    ['counting in before the first beat lands', { beat: null, countingIn: true }, 'Counting in, beat 1'],
  ])('announces %s', (_label, props, expected) => {
    render(<BeatPulse beatsPerBar={4} {...props} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', expected);
  });

  it('falls back to 4 beats when the time signature is unusable', () => {
    const { container } = render(<BeatPulse beatsPerBar={NaN} beat={null} />);
    expect(dotsOf(container)).toHaveLength(4);
  });

  it('never renders an empty row for a zero or negative beat count', () => {
    const { container } = render(<BeatPulse beatsPerBar={0} beat={null} />);
    expect(dotsOf(container)).toHaveLength(1);
  });
});

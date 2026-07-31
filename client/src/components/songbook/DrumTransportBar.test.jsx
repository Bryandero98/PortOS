import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import DrumTransportBar from './DrumTransportBar.jsx';
import { DRUM_KIT_IDS } from '../../lib/drumKits.js';

// The phone-first split (primary controls always visible, setup behind a
// disclosure under `sm`) is the whole point of this bar — pin it, plus the
// callbacks the viewer wires to `useDrumPlayer`.

const props = (extra = {}) => ({
  playing: false,
  onToggle: vi.fn(),
  bpm: 96,
  onBpmChange: vi.fn(),
  onPercent: vi.fn(),
  writtenTempo: 96,
  countInBars: 1,
  onCountInChange: vi.fn(),
  loopEnabled: false,
  onLoopToggle: vi.fn(),
  loopFrom: 1,
  loopTo: 4,
  onLoopRangeChange: vi.fn(),
  barCount: 4,
  clickEnabled: true,
  onClickToggle: vi.fn(),
  clickVolume: 1,
  onClickVolumeChange: vi.fn(),
  kitId: '909',
  onKitChange: vi.fn(),
  beatsPerBar: 4,
  pulse: null,
  currentBar: 1,
  ...extra,
});

afterEach(cleanup);

describe('DrumTransportBar', () => {
  it('keeps play, tempo and the metronome in the always-visible primary row', () => {
    render(<DrumTransportBar {...props()} />);
    // No disclosure needed for any of these.
    expect(screen.getByLabelText('Play along')).toBeTruthy();
    expect(screen.getByLabelText('Practice tempo (BPM)').value).toBe('96');
    expect(screen.getByLabelText('Turn the metronome off')).toBeTruthy();
  });

  it('keeps the metronome volume beside its mute, in the primary row', () => {
    // The confusion this fixes: with the BPM slider as the bar's only slider,
    // the tempo control read as a volume. So the metronome carries its OWN
    // slider next to a speaker button, and the tempo is labelled in BPM.
    const p = props();
    render(<DrumTransportBar {...p} />);
    const volume = screen.getByLabelText('Metronome volume');
    expect(volume.type).toBe('range');
    expect(volume.value).toBe('100');
    fireEvent.change(volume, { target: { value: '40' } });
    // The slider is 0–100; the player's level is 0–1.
    expect(p.onClickVolumeChange).toHaveBeenCalledWith(0.4);
    expect(screen.getByText('BPM')).toBeTruthy();
  });

  it('shows the stored level and flips the icon-button between mute and unmute', () => {
    const p = props({ clickVolume: 0.35 });
    const { rerender } = render(<DrumTransportBar {...p} />);
    expect(screen.getByLabelText('Metronome volume').value).toBe('35');
    fireEvent.click(screen.getByLabelText('Turn the metronome off'));
    expect(p.onClickToggle).toHaveBeenCalledWith(false);

    rerender(<DrumTransportBar {...props({ clickEnabled: false, clickVolume: 0.35 })} />);
    // Muted still shows the level — it's what you get back when you unmute.
    expect(screen.getByLabelText('Turn the metronome on')).toBeTruthy();
    expect(screen.getByLabelText('Metronome volume').value).toBe('35');
  });

  it('collapses the setup controls under sm and expands them on the disclosure', () => {
    render(<DrumTransportBar {...props()} />);
    const toggle = screen.getByLabelText('Show practice settings');
    const setup = document.getElementById('drum-setup-controls');
    // jsdom applies no media queries, so the contract is the class pair: hidden
    // by default, `sm:flex` restoring it once there's room.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(setup.className).toContain('hidden');
    expect(setup.className).toContain('sm:flex');

    fireEvent.click(toggle);
    expect(screen.getByLabelText('Hide practice settings').getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('drum-setup-controls').className).toContain('flex');
    expect(document.getElementById('drum-setup-controls').className).not.toContain('hidden');
  });

  it('steps the tempo in fives from the buttons', () => {
    const p = props();
    render(<DrumTransportBar {...p} />);
    fireEvent.click(screen.getByLabelText('Faster by 5 BPM'));
    expect(p.onBpmChange).toHaveBeenCalledWith(101);
    fireEvent.click(screen.getByLabelText('Slower by 5 BPM'));
    expect(p.onBpmChange).toHaveBeenCalledWith(91);
  });

  it.each([
    ['stopped', { pulse: null }, 'Stopped', '1/4'],
    ['mid-bar', { pulse: { bar: 2, beat: 3, countingIn: false }, currentBar: 2 }, 'Beat 3', '2/4'],
    ['counting in', { pulse: { bar: null, beat: 1, countingIn: true } }, 'Counting in, beat 1', 'count-in'],
  ])('reads the pulse while %s', (_name, extra, label, readout) => {
    render(<DrumTransportBar {...props(extra)} />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(label);
    expect(screen.getByText(readout)).toBeTruthy();
  });

  it('draws a dot per notated beat of the bar, whatever the time signature', () => {
    render(<DrumTransportBar {...props({ beatsPerBar: 6 })} />);
    expect(screen.getByRole('status').querySelectorAll('span')).toHaveLength(6);
  });

  it('picks the kit from the setup row, listing every kit', () => {
    const p = props();
    render(<DrumTransportBar {...p} />);
    const select = screen.getByLabelText('Kit');
    expect(select.value).toBe('909');
    expect([...select.options].map((o) => o.value)).toEqual(DRUM_KIT_IDS);
    fireEvent.change(select, { target: { value: '808' } });
    expect(p.onKitChange).toHaveBeenCalledWith('808');
  });

  it('marks the percent button matching the current BPM', () => {
    render(<DrumTransportBar {...props({ bpm: 48, writtenTempo: 96 })} />);
    expect(screen.getByRole('button', { name: '50%' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '100%' }).getAttribute('aria-pressed')).toBe('false');
  });
});

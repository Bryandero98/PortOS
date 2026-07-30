import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockPlayer = vi.hoisted(() => ({
  playing: false,
  toggle: vi.fn(),
  stop: vi.fn(),
  hasMusic: true,
  bpm: 96,
  setBpm: vi.fn(),
  setBpmPercent: vi.fn(),
  writtenTempo: 96,
  countInBars: 1,
  setCountInBars: vi.fn(),
  loopEnabled: false,
  setLoopEnabled: vi.fn(),
  loopFrom: 1,
  loopTo: 1,
  setLoopRange: vi.fn(),
  barCount: 1,
  clickEnabled: true,
  setClickEnabled: vi.fn(),
  beatsPerBar: 4,
  pulse: null,
  currentBar: 1,
  getPlayhead: vi.fn(),
}));

const useDrumPlayer = vi.hoisted(() => vi.fn(() => mockPlayer));
vi.mock('../../hooks/useDrumPlayer.js', () => ({ default: useDrumPlayer }));
vi.mock('./DrumTransportBar.jsx', () => ({
  default: ({ onToggle, playing, hasMusic }) => (
    <button type="button" onClick={onToggle} disabled={!hasMusic}>
      {playing ? 'Stop preview' : 'Play preview'}
    </button>
  ),
}));
vi.mock('./DrumSheetView.jsx', () => ({
  default: ({ text, playing }) => <div data-testid="drum-sheet" data-playing={playing}>{text}</div>,
}));

import DrumPreview from './DrumPreview.jsx';

const CHART_A = 'tempo: 96\nHH: x---\nK: o---';
const CHART_B = 'tempo: 96\nHH: xxxx\nK: o-o-';

describe('DrumPreview', () => {
  beforeEach(() => {
    mockPlayer.playing = false;
    mockPlayer.toggle.mockReset();
    mockPlayer.stop.mockReset();
    useDrumPlayer.mockClear();
  });

  it('freezes the sounding chart and sheet while live text changes', () => {
    const { rerender } = render(<DrumPreview text={CHART_A} />);
    mockPlayer.playing = true;
    rerender(<DrumPreview text={CHART_B} />);

    expect(useDrumPlayer.mock.calls.at(-1)[0]).toBe(CHART_A);
    expect(screen.getByTestId('drum-sheet').textContent).toBe(CHART_A);
    expect(screen.getByText('Chart changed — press Play to reload.')).toBeTruthy();
  });

  it('rebuilds from the latest snapshot before starting after a change', async () => {
    const { rerender } = render(<DrumPreview text={CHART_A} />);
    rerender(<DrumPreview text={CHART_B} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play preview' }));

    await waitFor(() => expect(useDrumPlayer.mock.calls.at(-1)[0]).toBe(CHART_B));
    expect(mockPlayer.toggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Chart changed — press Play to reload.')).toBeNull();
  });

});

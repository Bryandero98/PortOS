import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { themeMode } = vi.hoisted(() => ({ themeMode: { current: 'night' } }));
vi.mock('../ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: themeMode.current } }),
}));

import { AGENT_STATES } from './constants';
import { chipColors, parseColor, contrastRatio, chipBackdrop } from '../../lib/chipContrast';
import TerminalCoSPanel from './TerminalCoSPanel';

const renderPanel = (state) => render(
  <TerminalCoSPanel
    state={state}
    speaking={false}
    statusMessage="Processing..."
    eventLogs={[]}
    running={false}
    onStart={() => {}}
    onStop={() => {}}
    stats={{}}
  />
);

// The ASCII art rows are the only elements painted with the state color.
const asciiRows = (container) => [...container.querySelectorAll('div[style*="color"]')];

beforeEach(() => { themeMode.current = 'night'; });
afterEach(cleanup);

describe('TerminalCoSPanel state color', () => {
  // `AGENT_STATES` is an intentional 7-way category palette tuned for near-black
  // surfaces, but this panel's surface follows the theme — `thinking`'s amber
  // (#f59e0b) renders at ~2.1:1 on a day theme. This is the #1909 follow-up.
  it.each(['day', 'night'])('grades the state color for the %s theme mode', (mode) => {
    themeMode.current = mode;
    const { container } = renderPanel('thinking');

    const rows = asciiRows(container);
    expect(rows.length).toBeGreaterThan(0);
    const other = mode === 'day' ? 'night' : 'day';
    for (const row of rows) {
      // parseColor on both sides: jsdom normalizes an inline `#rrggbb` to `rgb(…)`,
      // so raw string comparison would pass no matter which mode was used.
      expect(parseColor(row.style.color))
        .toEqual(parseColor(chipColors(AGENT_STATES.thinking.color, mode).color));
      expect(parseColor(row.style.color))
        .not.toEqual(parseColor(chipColors(AGENT_STATES.thinking.color, other).color));
    }
  });

  it('clears WCAG AA in both modes for every agent state', () => {
    for (const mode of ['day', 'night']) {
      themeMode.current = mode;
      for (const [state, config] of Object.entries(AGENT_STATES)) {
        cleanup();
        const { container } = renderPanel(state);
        const ink = parseColor(asciiRows(container)[0].style.color);
        expect(contrastRatio(ink, chipBackdrop(parseColor(config.color), mode)), `${state} on ${mode}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('still labels the state from the same config entry', () => {
    renderPanel('thinking');
    expect(screen.getByText(/Thinking/)).toBeInTheDocument();
  });
});

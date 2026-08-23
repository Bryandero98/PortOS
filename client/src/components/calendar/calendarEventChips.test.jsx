import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// One suite for the three views because the thing under test is one contract
// shared across them: a subcalendar color is external Google Calendar data, so
// every chip that paints it as TEXT has to run it through `chipContrast` for the
// ACTIVE theme mode. Per-view files would triple the socket/api/theme scaffold
// to assert the same two lines.

const { socketMock } = vi.hoisted(() => ({
  socketMock: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../../services/socket', () => ({ default: socketMock }));

const { themeMode } = vi.hoisted(() => ({ themeMode: { current: 'night' } }));
vi.mock('../ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: themeMode.current } }),
}));

vi.mock('../../services/api', () => ({
  getCalendarEvents: vi.fn(),
  getChronotypeEnergySchedule: vi.fn(),
}));

import * as api from '../../services/api';
import { chipColors, parseColor } from '../../lib/chipContrast';
import MonthView from './MonthView';
import WeekView from './WeekView';
import DayView from './DayView';
import ChronotypeOverlay from './ChronotypeOverlay';

// A pale entry from Google's own subcalendar palette — the class of color that
// rendered near-invisible on the day themes.
const SUBCALENDAR_COLOR = '#fbd75b';
const ACCOUNTS = [{ subcalendars: [{ calendarId: 'cal-1', color: SUBCALENDAR_COLOR }] }];

const at = (hour) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

const ALL_DAY = {
  id: 'e1', accountId: 'acct-1', subcalendarId: 'cal-1',
  title: 'Quarter Close', isAllDay: true, startTime: at(0), endTime: at(23),
};
const TIMED = {
  id: 'e2', accountId: 'acct-1', subcalendarId: 'cal-1',
  title: 'Design Review', isAllDay: false, startTime: at(10), endTime: at(11),
};

const renderView = async (ui) => {
  render(<MemoryRouter>{ui}</MemoryRouter>);
  // Settle the mount-effect fetch inside act (see src/test/setup.js).
  await act(async () => {});
};

const chipFor = (title) => screen.getByRole('button', { name: new RegExp(title) });

/** The graded color for the ACTIVE mode, and for the other one. */
const expectGradedForActiveMode = (element, rawColor) => {
  const other = themeMode.current === 'day' ? 'night' : 'day';
  // parseColor on both sides: jsdom normalizes an inline `#rrggbb` into
  // `rgb(…)`, so comparing the raw strings would pass no matter which mode was
  // used to grade it.
  expect(parseColor(element.style.color))
    .toEqual(parseColor(chipColors(rawColor, themeMode.current).color));
  expect(parseColor(element.style.color))
    .not.toEqual(parseColor(chipColors(rawColor, other).color));
};

// `index.css` remaps these with `!important`, and author `!important` beats an
// inline declaration — so a chip that carries both renders in theme neutrals
// with its graded color silently dead. Day mode's remap covers `text-white`
// too, which is what made the timed-event titles ignore the block's color.
const IMPORTANT_UTILITIES = /(^|\s)(bg-port-bg|border-port-border|text-white|text-gray-\d00)(\s|$)/;
const IMPORTANT_TEXT_UTILITIES = /(^|\s)(text-white|text-gray-\d00)(\s|$)/;

const expectNoImportantUtilityUnderGrading = (container) => {
  for (const el of container.querySelectorAll('[style]')) {
    if (!el.style.color && !el.style.backgroundColor) continue;
    expect(el.className, `${el.tagName} carries a graded style AND an !important theme utility`)
      .not.toMatch(IMPORTANT_UTILITIES);
  }
};

/**
 * The graded color lives on the chip; the title is often a child that inherits
 * it. A child carrying `text-white`/`text-gray-*` overrides that inheritance
 * with `!important` on day mode — so assert every element that owns the title
 * text node is free of them.
 */
const expectTitleInheritsGrading = (chip, title) => {
  const owners = [chip, ...chip.querySelectorAll('*')].filter((el) => Array.from(el.childNodes)
    .some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes(title)));
  expect(owners.length, `no element renders "${title}"`).toBeGreaterThan(0);
  for (const el of owners) {
    expect(el.className, `"${title}" is painted by an !important theme utility, not the graded color`)
      .not.toMatch(IMPORTANT_TEXT_UTILITIES);
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  themeMode.current = 'night';
  api.getCalendarEvents.mockResolvedValue({ events: [ALL_DAY, TIMED] });
  api.getChronotypeEnergySchedule.mockResolvedValue(null);
});

afterEach(cleanup);

describe.each([
  ['MonthView', (accounts) => <MonthView accounts={accounts} />, ['Quarter Close']],
  ['WeekView', (accounts) => <WeekView accounts={accounts} />, ['Quarter Close', 'Design Review']],
  ['DayView', (accounts) => <DayView accounts={accounts} />, ['Quarter Close', 'Design Review']],
])('%s event chips', (_name, renderTarget, titles) => {
  it.each(['day', 'night'])('grades the subcalendar color for the %s theme mode', async (mode) => {
    themeMode.current = mode;
    await renderView(renderTarget(ACCOUNTS));

    for (const title of titles) expectGradedForActiveMode(chipFor(title), SUBCALENDAR_COLOR);
  });

  it('falls back to the accent chip when the subcalendar has no color', async () => {
    await renderView(renderTarget([]));

    for (const title of titles) {
      // `var(--port-accent, #3b82f6)` was the old fallback and is not a color —
      // `--port-accent` is a bare RGB triple, so it has to be wrapped in `rgb()`.
      expect(chipFor(title).style.color).toMatch(/^rgb\(var\(--port-accent/);
    }
  });

  it('never ships a graded inline style alongside an !important theme utility', async () => {
    themeMode.current = 'day';
    const { container } = render(<MemoryRouter>{renderTarget(ACCOUNTS)}</MemoryRouter>);
    await act(async () => {});
    expectNoImportantUtilityUnderGrading(container);
    for (const title of titles) expectTitleInheritsGrading(chipFor(title), title);
  });
});

describe('ChronotypeOverlay zone labels', () => {
  const ZONES = {
    zones: [
      { id: 'z1', label: 'Peak Focus', color: '#f59e0b', startMin: 9 * 60, endMin: 11 * 60, opacity: 0.12 },
      { id: 'z2', label: 'Caffeine Cutoff', color: '#f59e0b', startMin: 14 * 60, marker: true },
    ],
  };

  it.each(['day', 'night'])('grades the label ink for the %s theme mode', async (mode) => {
    themeMode.current = mode;
    api.getChronotypeEnergySchedule.mockResolvedValue(ZONES);
    await renderView(<ChronotypeOverlay startHour={6} pxPerHour={60} />);

    // The amber zone is ~2.1:1 on a day card — the live AA failure this fixes.
    for (const label of ['Peak Focus', 'Caffeine Cutoff']) {
      expectGradedForActiveMode(screen.getByText(label), '#f59e0b');
    }
  });

  it('keeps the band fill on the zone\'s own raw color', async () => {
    api.getChronotypeEnergySchedule.mockResolvedValue(ZONES);
    const { container } = render(<ChronotypeOverlay startHour={6} pxPerHour={60} />);
    await act(async () => {});
    // The band is a large tint, not text — grading it would shift the wash the
    // zone is recognized by, and it carries no ink of its own.
    const band = container.querySelector('div[style*="opacity"]');
    expect(parseColor(band.style.backgroundColor)).toEqual(parseColor('#f59e0b'));
  });
});

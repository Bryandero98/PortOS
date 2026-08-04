import { describe, expect, it } from 'vitest';
import { hoursUntilReset, normalizeResetAt } from './quotaReset.js';

describe('quota reset normalization', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');

  it('keeps an ISO reset instant exact', () => {
    expect(normalizeResetAt({ resetsAt: '2026-07-27T12:00:00.000Z' }, { now }))
      .toEqual({ epochMs: Date.parse('2026-07-27T12:00:00.000Z'), source: 'iso' });
  });

  it('uses null as the explicit unknown sentinel', () => {
    expect(normalizeResetAt({ resetsAt: null }, { now })).toEqual({ epochMs: null, source: 'unknown' });
    expect(hoursUntilReset({ resetsAt: 'not a date' }, { now })).toBeNull();
  });

  it('parses a local provider reset when a timezone is supplied', () => {
    const result = normalizeResetAt({ resetsAt: 'July 27, 2026 08:00:00', timezone: 'America/Los_Angeles' }, { now });
    expect(result).toEqual({ epochMs: Date.parse('2026-07-27T15:00:00.000Z'), source: 'parsed' });
  });

  // The exact strings the live CLIs emit. Both defeated a bare `Date.parse`:
  // claude's " at " + glued meridiem returned NaN (every window read as "no
  // reset time", so the family never burned), and a year-less string resolves
  // to 2001 rather than the current year.
  it('parses the claude panel shape — " at " separator and a glued meridiem', () => {
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 1:59pm', timezone: 'America/Los_Angeles' }, { now }))
      .toEqual({ epochMs: Date.parse('2026-07-27T20:59:00.000Z'), source: 'parsed' });
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 11:19am', timezone: 'America/Los_Angeles' }, { now }))
      .toEqual({ epochMs: Date.parse('2026-07-27T18:19:00.000Z'), source: 'parsed' });
  });

  it('parses a claude reset on the hour, which states no minutes at all', () => {
    // `Jul 7 at 2pm` — the shape claudeCodeUsage's own parser fixture emits.
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 2pm', timezone: 'UTC' }, { now }).epochMs)
      .toBe(Date.parse('2026-07-27T14:00:00.000Z'));
    // Midnight and noon are the two the 12-hour clock gets wrong most often.
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 12am', timezone: 'UTC' }, { now }).epochMs)
      .toBe(Date.parse('2026-07-27T00:00:00.000Z'));
    expect(normalizeResetAt({ resetsAt: 'Jul 27 at 12pm', timezone: 'UTC' }, { now }).epochMs)
      .toBe(Date.parse('2026-07-27T12:00:00.000Z'));
  });

  it('stamps a year-less reset with the CURRENT year, not Date.parse\'s 2001 default', () => {
    // Grok: `August 10, 06:07`, no year, no zone stated.
    const { epochMs, source } = normalizeResetAt({ resetsAt: 'August 10, 06:07', timezone: 'UTC' }, { now });
    expect(source).toBe('parsed');
    expect(epochMs).toBe(Date.parse('2026-08-10T06:07:00.000Z'));
    expect(hoursUntilReset({ resetsAt: 'August 10, 06:07', timezone: 'UTC' }, { now })).toBeCloseTo(354.1, 0);
  });

  it('rolls a year-less reset that already passed to next year', () => {
    // Read on Dec 31, a "Jan 2" reset belongs to the coming year.
    const newYearsEve = Date.parse('2026-12-31T18:00:00.000Z');
    expect(normalizeResetAt({ resetsAt: 'Jan 2 at 9:00am', timezone: 'UTC' }, { now: newYearsEve }).epochMs)
      .toBe(Date.parse('2027-01-02T09:00:00.000Z'));
  });

  it('keeps a reset that just passed in the past rather than pushing it a year out', () => {
    const justPassed = normalizeResetAt({ resetsAt: 'Jul 26 at 11:30am', timezone: 'UTC' }, { now });
    expect(justPassed.epochMs).toBe(Date.parse('2026-07-26T11:30:00.000Z'));
    expect(hoursUntilReset({ resetsAt: 'Jul 26 at 11:30am', timezone: 'UTC' }, { now })).toBeCloseTo(-0.5, 5);
  });
});

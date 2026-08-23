import { chipColors } from '../../lib/chipContrast';

/**
 * Neutral chip for an event whose subcalendar has no color (or one we can't
 * parse). `--port-accent` is a space-separated RGB triple, so it only becomes a
 * color inside `rgb()` — the older `var(--port-accent, #3b82f6)` idiom resolved
 * to the literal `59 130 246`, which is not a valid color, so the browser
 * dropped the declaration and the text quietly inherited instead of painting
 * the accent.
 */
const ACCENT = 'rgb(var(--port-accent, 59 130 246))';
const NEUTRAL_EVENT_STYLE = Object.freeze({
  color: ACCENT,
  borderColor: ACCENT,
  backgroundColor: 'rgb(var(--port-accent, 59 130 246) / 0.15)',
});

/**
 * Inline style for one calendar event chip/block: `{ color, borderColor,
 * backgroundColor }` ready to spread into a `style` prop.
 *
 * A subcalendar color is Google Calendar data — picked by whoever created the
 * subcalendar, against whatever surface their calendar app uses — so it can't
 * be painted verbatim as text: Google's palette includes several pale entries
 * that land near 1:1 against a day theme's card. `chipColors` keeps the hue and
 * moves only the lightness until it clears WCAG AA on the ACTIVE theme mode.
 *
 * Callers must NOT also put an `!important` theme utility (`text-white`,
 * `text-gray-*`, `bg-port-bg`, `border-port-border`) on the element carrying
 * this style — `index.css` remaps those with `!important`, which beats an inline
 * declaration and would silently kill the graded color.
 *
 * @param {string|null|undefined} color subcalendar color (hex)
 * @param {'day'|'night'|undefined} mode active theme mode
 */
export function eventChipStyle(color, mode) {
  return chipColors(color, mode) || NEUTRAL_EVENT_STYLE;
}

/**
 * Build a Map of subcalendarId → color from the accounts array.
 * Used by Day, Week, and Month views for event color coding.
 */
export function buildSubcalendarColorMap(accounts) {
  const map = new Map();
  for (const account of (accounts || [])) {
    for (const sc of (account.subcalendars || [])) {
      if (sc.color) map.set(sc.calendarId, sc.color);
    }
  }
  return map;
}

// Scrolling the Shell terminal — by touch at all, and inside a full-screen TUI.
//
// Two separate gaps land on one primitive, which is why one module covers both:
//
//   • xterm.js 6 has NO touch input path. Its viewport is VS Code's
//     SmoothScrollableElement: the scroll extent is virtual (there is no oversized
//     spacer element for the browser to scroll natively — the `.xterm-scroll-area`
//     of earlier versions is gone), and the only inputs it binds are `wheel` and
//     scrollbar drags; the vendored `Gesture` helper is never given a target. So a
//     swipe over the terminal does nothing at all, in ANY session. On a phone —
//     where watched agent runs are mostly read — that is the entire scroll story.
//
//   • The ALTERNATE screen buffer that a TUI takes (a watched `claude`/`codex` run,
//     `vim`, `less`, `htop`) has no scrollback by construction: `ybase` stays 0, so
//     `scrollLines()` and friends clamp to a no-op there. Scrolling an alt-screen
//     app means handing the scroll to the APP, which owns its own scroll region.
//
// The primitive is a synthesized wheel event on `terminal.element`. That is not a
// shortcut around xterm — it is the only injection point xterm offers
// (`attachCustomWheelEventHandler` intercepts wheels, it cannot inject one), and
// going through it lets xterm's own decision table pick what to emit: an SGR mouse
// report when the TUI enabled wheel tracking, a cursor key ("alternate scroll") when
// it did not. Deciding that here would mean duplicating protocol state the public
// API doesn't expose — `modes` reports `mouseTrackingMode`, but not the encoding.
// The normal buffer is the one case driven directly, through the real `scrollLines()`.
//
// Scrolling back PAST a TUI, into what the shell printed before it started, stays
// impossible while it holds the alternate screen. That is terminal semantics, not a
// gap here.

// One dispatched wheel event is one scroll step, whatever delta it carries: both of
// xterm's alternate-buffer paths emit exactly one report (a mouse event, or a single
// cursor key) per wheel event and ignore the magnitude. N lines therefore means N
// events — bounded so a fling or a huge `rows` can't become an unbounded loop.
const MAX_WHEEL_STEPS = 64;

// Used when the terminal hasn't been laid out yet, so a swipe on a freshly-attached
// session still scrolls instead of silently accumulating pixels forever.
const FALLBACK_ROW_HEIGHT_PX = 18;

// DOM_DELTA_LINE, not pixels: xterm's wheel accumulator divides a PIXEL delta by the
// device cell height and additionally damps deltas under 50px, so a synthesized pixel
// event is liable to round to zero steps and scroll nothing. A line delta is read as
// whole lines with no accumulator.
const WHEEL_DELTA_MODE_LINE = 1;

const isAltBuffer = (terminal) => terminal?.buffer?.active?.type === 'alternate';

// `.xterm-screen` is the element that is exactly rows × cellHeight; the outer
// `.xterm` container can carry padding that would skew a row height taken from it.
const screenElement = (terminal) => {
  const el = terminal?.element;
  return el ? el.querySelector('.xterm-screen') || el : null;
};

/**
 * Measure the terminal once per gesture: the row height that turns drag pixels into
 * lines, and the screen's centre, which a synthesized wheel needs because xterm
 * resolves the event to a cell and drops any mouse report landing outside the screen.
 *
 * Hoisted out of the per-move path deliberately — both are layout-forcing reads, and
 * PortOS runs xterm's DOM renderer, so during a live TUI run layout is dirty every
 * frame and a read per `touchmove` costs a full style+layout flush of the row grid at
 * touch frequency. Neither value can change inside a drag we are preventDefault-ing.
 */
export const measureTerminalGeometry = (terminal) => {
  const rect = screenElement(terminal)?.getBoundingClientRect();
  const rows = terminal?.rows || 0;
  return {
    rowHeightPx: rect?.height > 0 && rows ? rect.height / rows : FALLBACK_ROW_HEIGHT_PX,
    clientX: rect ? rect.left + rect.width / 2 : 0,
    clientY: rect ? rect.top + rect.height / 2 : 0,
  };
};

// A screenful, minus one row of overlap so the reader keeps a line of context — the
// same convention a pager uses for Page Up/Down.
const terminalPageLines = (terminal) => Math.max(1, (terminal?.rows ?? 1) - 1);

/**
 * Scroll the terminal by `lines` (negative = toward older output). Pass `geometry`
 * from `measureTerminalGeometry` to reuse a gesture's measurement; omit it for
 * one-shot calls. Returns the lines actually applied, signed — which is the clamp-
 * aware count, not the request.
 */
export const scrollTerminalLines = (terminal, lines, geometry) => {
  const requested = Math.trunc(lines);
  if (!terminal || !requested) return 0;

  // Normal buffer: the scrollback is real and only the real API moves it — the
  // viewport is virtual, so there is no native scroller a wheel event could drive.
  if (!isAltBuffer(terminal)) {
    terminal.scrollLines?.(requested);
    return requested;
  }

  const el = terminal.element;
  if (!el?.dispatchEvent || typeof WheelEvent === 'undefined') return 0;
  const up = requested < 0;
  const steps = Math.min(Math.abs(requested), MAX_WHEEL_STEPS);
  const { clientX, clientY } = geometry || measureTerminalGeometry(terminal);
  const init = {
    deltaY: up ? -1 : 1,
    deltaMode: WHEEL_DELTA_MODE_LINE,
    clientX,
    clientY,
    bubbles: true,
    cancelable: true,
  };
  for (let i = 0; i < steps; i++) el.dispatchEvent(new WheelEvent('wheel', init));
  return up ? -steps : steps;
};

/** Scroll one screenful. `direction` is -1 for up (older), 1 for down. */
export const scrollTerminalPage = (terminal, direction) =>
  scrollTerminalLines(terminal, terminalPageLines(terminal) * (direction < 0 ? -1 : 1));

/**
 * Convert accumulated drag distance into whole scroll steps, keeping the sub-row
 * remainder so a slow drag adds up instead of being truncated away every frame.
 * `accumPx` is positive when the finger moved UP (content scrolls down), matching the
 * sign convention of `scrollTerminalLines`.
 */
export const planTouchScrollSteps = (accumPx, rowHeightPx) => {
  if (!(rowHeightPx > 0)) return { steps: 0, remainderPx: accumPx };
  const steps = Math.trunc(accumPx / rowHeightPx);
  return { steps, remainderPx: accumPx - steps * rowHeightPx };
};

/**
 * Make a one-finger drag scroll the terminal. Returns a detach function.
 *
 * Buffer-agnostic on purpose: `scrollTerminalLines` already branches, and the gap
 * this closes (xterm 6 binds no touch handlers) is not specific to a TUI — an
 * ordinary shell's scrollback is just as unswipeable without it.
 */
export const attachTerminalTouchScroll = (terminal) => {
  const el = terminal?.element;
  if (!el?.addEventListener) return () => {};

  let lastY = null;
  let accumPx = 0;
  let geometry = null;

  const end = () => { lastY = null; accumPx = 0; geometry = null; };

  const onStart = (ev) => {
    // Two fingers is a pinch-zoom, which belongs to the browser.
    if (ev.touches?.length !== 1) return end();
    lastY = ev.touches[0].clientY;
    accumPx = 0;
    geometry = measureTerminalGeometry(terminal);
  };

  const onMove = (ev) => {
    if (lastY == null) return;
    if (ev.touches?.length !== 1) return end();
    const y = ev.touches[0].clientY;
    accumPx += lastY - y;
    lastY = y;
    const { steps, remainderPx } = planTouchScrollSteps(accumPx, geometry.rowHeightPx);
    if (!steps) return;
    accumPx = remainderPx;
    // Swallow the gesture only once it has resolved into a scroll — before that it
    // may still be a tap, and a TUI with mouse tracking on wants the click.
    if (ev.cancelable) ev.preventDefault();
    scrollTerminalLines(terminal, steps, geometry);
  };

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });

  return () => {
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', end);
    el.removeEventListener('touchcancel', end);
  };
};

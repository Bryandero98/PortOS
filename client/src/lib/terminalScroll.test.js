import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  measureTerminalGeometry,
  planTouchScrollSteps,
  scrollTerminalLines,
  scrollTerminalPage,
  attachTerminalTouchScroll,
} from './terminalScroll.js';

// A stand-in for the xterm instance carrying only what this module reads. The real
// Terminal can't be driven here: xterm's own wheel handlers bail out when the render
// service has no measured cell height (jsdom has no layout), which is why these tests
// assert the SHAPE of the dispatched wheel event rather than what xterm does with it —
// the contract this module owns is "emit what a real wheel emits".
const makeTerminal = ({ alt = true, rows = 24, height = 480 } = {}) => {
  const el = document.createElement('div');
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  el.appendChild(screen);
  document.body.appendChild(el);
  screen.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height, right: 900, bottom: 50 + height });
  return {
    element: el,
    rows,
    buffer: { active: { type: alt ? 'alternate' : 'normal' } },
    scrollLines: vi.fn(),
  };
};

const touchEvent = (type, touches) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  ev.touches = touches.map((clientY) => ({ clientY }));
  return ev;
};

// Returns the array the assertions read; every dispatched wheel lands in it.
const captureWheels = (term) => {
  const wheels = [];
  term.element.addEventListener('wheel', (ev) => wheels.push(ev));
  return wheels;
};

afterEach(() => { document.body.innerHTML = ''; });

describe('measureTerminalGeometry', () => {
  it('derives the row height from the rendered screen, not the outer container', () => {
    expect(measureTerminalGeometry(makeTerminal({ rows: 24, height: 480 })).rowHeightPx).toBe(20);
  });

  it('falls back to a nominal row height before the terminal has been laid out', () => {
    expect(measureTerminalGeometry(makeTerminal({ rows: 24, height: 0 })).rowHeightPx).toBe(18);
    expect(measureTerminalGeometry(null).rowHeightPx).toBe(18);
  });

  it('centres on the screen so a synthesized wheel resolves to a real cell', () => {
    // .xterm-screen rect is left 100 / width 800, top 50 / height 480.
    expect(measureTerminalGeometry(makeTerminal({ height: 480 }))).toMatchObject({ clientX: 500, clientY: 290 });
  });
});

describe('planTouchScrollSteps', () => {
  it('holds back a sub-row drag and carries the remainder into the next one', () => {
    expect(planTouchScrollSteps(8, 20)).toEqual({ steps: 0, remainderPx: 8 });
    expect(planTouchScrollSteps(24, 20)).toEqual({ steps: 1, remainderPx: 4 });
  });

  it('truncates toward zero in both directions', () => {
    expect(planTouchScrollSteps(-45, 20)).toEqual({ steps: -2, remainderPx: -5 });
    expect(planTouchScrollSteps(45, 20)).toEqual({ steps: 2, remainderPx: 5 });
  });

  it('is inert without a usable row height', () => {
    expect(planTouchScrollSteps(120, 0)).toEqual({ steps: 0, remainderPx: 120 });
  });
});

describe('scrollTerminalLines', () => {
  it('uses the real scrollback API in the normal buffer', () => {
    const term = makeTerminal({ alt: false });
    const wheels = captureWheels(term);
    expect(scrollTerminalLines(term, -5)).toBe(-5);
    expect(term.scrollLines).toHaveBeenCalledWith(-5);
    // The viewport's scroll extent is virtual, so a wheel event would move nothing.
    expect(wheels).toHaveLength(0);
  });

  it('dispatches one wheel event per line in the alternate buffer', () => {
    const term = makeTerminal();
    const wheels = captureWheels(term);
    expect(scrollTerminalLines(term, -3)).toBe(-3);
    expect(term.scrollLines).not.toHaveBeenCalled();
    // One event == one scroll step whichever path xterm takes, so the magnitude is
    // fixed at one line and the COUNT carries the distance.
    expect(wheels.map((ev) => ev.deltaY)).toEqual([-1, -1, -1]);
    expect(wheels.every((ev) => ev.deltaMode === WheelEvent.DOM_DELTA_LINE)).toBe(true);
  });

  it('scrolls down with a positive delta', () => {
    const term = makeTerminal();
    const wheels = captureWheels(term);
    scrollTerminalLines(term, 2);
    expect(wheels.map((ev) => ev.deltaY)).toEqual([1, 1]);
  });

  it('positions the wheel inside the rendered screen so the mouse report is not dropped', () => {
    const term = makeTerminal({ height: 480 });
    const wheels = captureWheels(term);
    scrollTerminalLines(term, -1);
    expect(wheels[0].clientX).toBe(500);
    expect(wheels[0].clientY).toBe(290);
  });

  it('never sets shiftKey — xterm reads it as "scroll the browser, not the terminal"', () => {
    const term = makeTerminal();
    const wheels = captureWheels(term);
    scrollTerminalLines(term, -1);
    expect(wheels[0].shiftKey).toBe(false);
  });

  it('bounds a fling instead of dispatching an unbounded run of events', () => {
    const term = makeTerminal();
    const wheels = captureWheels(term);
    expect(scrollTerminalLines(term, -5000)).toBe(-64);
    expect(wheels).toHaveLength(64);
  });

  it('reuses a supplied geometry instead of re-measuring', () => {
    const term = makeTerminal();
    const wheels = captureWheels(term);
    scrollTerminalLines(term, -1, { rowHeightPx: 20, clientX: 7, clientY: 9 });
    expect(wheels[0].clientX).toBe(7);
    expect(wheels[0].clientY).toBe(9);
  });

  it('is a no-op for zero, a fractional delta, or no terminal', () => {
    const term = makeTerminal();
    const wheels = captureWheels(term);
    expect(scrollTerminalLines(term, 0)).toBe(0);
    expect(scrollTerminalLines(term, 0.4)).toBe(0);
    expect(scrollTerminalLines(null, -3)).toBe(0);
    expect(wheels).toHaveLength(0);
  });
});

describe('scrollTerminalPage', () => {
  it('moves a screenful minus one row of overlap', () => {
    const term = makeTerminal({ alt: false, rows: 24 });
    scrollTerminalPage(term, -1);
    expect(term.scrollLines).toHaveBeenCalledWith(-23);
    scrollTerminalPage(term, 1);
    expect(term.scrollLines).toHaveBeenCalledWith(23);
  });

  it('still moves a line on a one-row terminal', () => {
    const term = makeTerminal({ alt: false, rows: 1 });
    scrollTerminalPage(term, -1);
    expect(term.scrollLines).toHaveBeenCalledWith(-1);
  });
});

describe('attachTerminalTouchScroll', () => {
  it('scrolls the alternate buffer on a one-finger drag, and swallows the gesture', () => {
    const term = makeTerminal({ rows: 24, height: 480 }); // 20px rows
    const wheels = captureWheels(term);
    const detach = attachTerminalTouchScroll(term);

    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    // Finger moves DOWN 60px → pull older output into view → three lines of scroll up.
    const move = touchEvent('touchmove', [360]);
    term.element.dispatchEvent(move);

    expect(wheels.map((ev) => ev.deltaY)).toEqual([-1, -1, -1]);
    expect(move.defaultPrevented).toBe(true);
    detach();
  });

  it('scrolls down when the finger moves up', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const wheels = captureWheels(term);
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [260]));
    expect(wheels.map((ev) => ev.deltaY)).toEqual([1, 1]);
    detach();
  });

  it('scrolls an ordinary shell session too — xterm 6 binds no touch handlers at all', () => {
    const term = makeTerminal({ alt: false, rows: 24, height: 480 });
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    const move = touchEvent('touchmove', [360]);
    term.element.dispatchEvent(move);
    expect(term.scrollLines).toHaveBeenCalledWith(-3);
    expect(move.defaultPrevented).toBe(true);
    detach();
  });

  it('leaves a sub-row drag alone so a tap still reaches the TUI', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const wheels = captureWheels(term);
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    const move = touchEvent('touchmove', [305]);
    term.element.dispatchEvent(move);
    expect(wheels).toHaveLength(0);
    expect(move.defaultPrevented).toBe(false);
    detach();
  });

  it('still scrolls when the terminal has not been laid out (fallback row height)', () => {
    const term = makeTerminal({ rows: 24, height: 0 });
    const wheels = captureWheels(term);
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [336])); // 36px / 18px rows
    expect(wheels).toHaveLength(2);
    detach();
  });

  it('measures once per gesture rather than on every move', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const screen = term.element.querySelector('.xterm-screen');
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    const measure = vi.spyOn(screen, 'getBoundingClientRect');
    for (let y = 320; y <= 500; y += 20) term.element.dispatchEvent(touchEvent('touchmove', [y]));
    expect(measure).not.toHaveBeenCalled();
    detach();
  });

  it('ignores a two-finger gesture (pinch-zoom belongs to the browser)', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const wheels = captureWheels(term);
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300, 400]));
    term.element.dispatchEvent(touchEvent('touchmove', [200, 500]));
    expect(wheels).toHaveLength(0);
    detach();
  });

  it('does not carry drag distance across separate gestures', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const wheels = captureWheels(term);
    const detach = attachTerminalTouchScroll(term);
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [315]));
    term.element.dispatchEvent(touchEvent('touchend', []));
    expect(wheels).toHaveLength(0);
    // A fresh 15px drag totals 30px — over one 20px row — only if the first
    // gesture's remainder leaked through.
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [315]));
    expect(wheels).toHaveLength(0);
    detach();
  });

  it('detaches every listener', () => {
    const term = makeTerminal({ rows: 24, height: 480 });
    const wheels = captureWheels(term);
    const detach = attachTerminalTouchScroll(term);
    detach();
    term.element.dispatchEvent(touchEvent('touchstart', [300]));
    term.element.dispatchEvent(touchEvent('touchmove', [400]));
    expect(wheels).toHaveLength(0);
  });

  it('returns a safe no-op when the terminal has no element yet', () => {
    expect(() => attachTerminalTouchScroll(null)()).not.toThrow();
    expect(() => attachTerminalTouchScroll({})()).not.toThrow();
  });
});

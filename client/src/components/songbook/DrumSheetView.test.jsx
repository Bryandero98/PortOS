import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, cleanup, act } from '@testing-library/react';
import DrumSheetView from './DrumSheetView.jsx';

// Invented grooves only (privacy convention).
const ROCK_BEAT = `time: 4/4
tempo: 96
subdivision: 4

# Bar 1 — basic rock beat
HH: x x x x x x x x
S:  - - - - o - - -
K:  o - - - - - o -`;

const count = (html, tag) => (html.match(new RegExp(`<${tag}[ />]`, 'g')) || []).length;

afterEach(cleanup);

describe('DrumSheetView', () => {
  it('renders a bar-gridded kit sheet with no NaN geometry', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} />);
    expect(html).not.toMatch(/NaN/);
    expect(html).toContain('Bar 1 — basic rock beat');
    expect(html).toContain('Hi-Hat');
    expect(html).toContain('Snare');
    expect(html).toContain('Kick');
  });

  it('shows the chart header summary', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} />);
    expect(html).toContain('4/4');
    expect(html).toContain('96');
    expect(html).toContain('4 per beat');
    expect(html).toContain('1 bar');
  });

  it('labels the tempo with the ACTUAL beat unit, not always a quarter note', () => {
    // The tempo counts notated beats (the time-signature denominator), which is
    // what playback schedules against — so 6/8 must read as eighth = bpm.
    expect(renderToStaticMarkup(<DrumSheetView text={'time: 4/4\ntempo: 96\n\nK: o'} />)).toContain('♩ = 96');
    expect(renderToStaticMarkup(<DrumSheetView text={'time: 6/8\ntempo: 96\n\nK: o'} />)).toContain('♪ = 96');
    expect(renderToStaticMarkup(<DrumSheetView text={'time: 2/2\ntempo: 60\n\nK: o'} />)).toContain('= 60');
    // An unlisted denominator degrades to a fraction rather than a wrong glyph.
    expect(renderToStaticMarkup(<DrumSheetView text={'time: 4/3\ntempo: 60\n\nK: o'} />)).toContain('1/3 = 60');
  });

  it('takes ink from the theme CSS vars via style, never a var() attribute', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} />);
    // SVG presentation attributes don't evaluate var() — every themed color must
    // arrive through the style prop.
    expect(html).not.toMatch(/(?:fill|stroke)="(?:rgb\()?var\(/);
    expect(html).toContain('--port-text');
  });

  it('draws one glyph per struck cell only', () => {
    // subdivision 1 → 4 cells/bar; two hits on one row.
    const html = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nK: o-o-'} />);
    expect(count(html, 'circle')).toBe(2);
  });

  it('draws crosses for cymbal-family rows and heads for drums', () => {
    const hats = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nHH: xxxx'} />);
    const kick = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nK: oooo'} />);
    expect(count(hats, 'circle')).toBe(0);      // × strokes, no noteheads
    expect(count(kick, 'circle')).toBe(4);
  });

  it('rings an open hi-hat and adds an accent chevron', () => {
    const open = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nHH: o---'} />);
    expect(count(open, 'circle')).toBe(1);      // the open ring around the ×
    const accent = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nS: X---'} />);
    expect(count(accent, 'path')).toBe(1);      // the accent chevron
  });

  it('draws a flam as a grace glyph plus the main hit', () => {
    const plain = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nS: x---'} />);
    const flam = renderToStaticMarkup(<DrumSheetView text={'subdivision: 1\n\nS: f---'} />);
    expect(count(flam, 'circle')).toBe(count(plain, 'circle') + 1);
  });

  // --- Continuous lane -------------------------------------------------------

  it('lays the whole song out in ONE horizontal lane, not a grid per bar', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'# A x3\nHH: xxxx'} />);
    // Two svgs total regardless of bar count: the frozen label column + the lane.
    expect(count(html, 'svg')).toBe(2);
    // And exactly one scroller for the song.
    expect((html.match(/overflow-x-auto/g) || []).length).toBe(1);
  });

  it('numbers every bar but only repeats a section label where it changes', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'# Verse x3\nHH: xxxx\n\n# Chorus\nS: xxxx'} />);
    expect((html.match(/Verse/g) || []).length).toBe(1);   // 3 bars, 1 label
    expect((html.match(/Chorus/g) || []).length).toBe(1);
    expect(html).toContain('>4<');                          // bar 4 still numbered
  });

  it('keeps the kit labels in their own column so they survive scrolling', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} />);
    const labelSvg = html.slice(html.indexOf('<svg'), html.indexOf('overflow-x-auto'));
    expect(labelSvg).toContain('Hi-Hat');
    expect(labelSvg).toContain('aria-hidden="true"');
    // …and names them on the lane instead, since the column is aria-hidden.
    expect(html).toMatch(/aria-label="Drum chart[^"]*Hi-Hat/);
  });

  it('scales the whole lane off the viewer font control', () => {
    const small = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} fontSizeRem={0.875} />);
    const large = renderToStaticMarkup(<DrumSheetView text={ROCK_BEAT} fontSizeRem={1.75} />);
    const laneWidth = (html) => Number(/<svg[^>]*viewBox="0 0 (\d+(?:\.\d+)?)[^"]*"[^>]*width="(\d+(?:\.\d+)?)"/.exec(html.slice(html.indexOf('overflow-x-auto')))?.[2]);
    expect(laneWidth(large)).toBeCloseTo(laneWidth(small) * 2, 1);
  });

  it('renders the sheet AND an errors summary for a partly-bad chart', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'CB: xxxx\nHH: xxxx'} />);
    expect(html).toContain('aria-label="Drum chart');   // the good row still drew
    expect(html).toContain('unknown kit piece');
    expect(html).toContain('1 chart note');
  });

  it('shows an empty-state hint (not a crash) for empty input', () => {
    for (const text of ['', null, undefined, 'time: 4/4']) {
      const html = renderToStaticMarkup(<DrumSheetView text={text} />);
      expect(html).toContain('No drum chart yet');
    }
  });

  it('reports errors even when nothing parsed into a bar', () => {
    const html = renderToStaticMarkup(<DrumSheetView text={'time: nope\n\nCB: xxxx'} />);
    expect(html).toContain('No readable bars');
    expect(html).toContain('bad time signature');
  });

  it('adds tap targets only when onStepClick is provided', () => {
    const chart = 'subdivision: 1\n\nHH: xxxx';
    // The playhead column is the one rect a static sheet carries.
    expect(count(renderToStaticMarkup(<DrumSheetView text={chart} />), 'rect')).toBe(1);
    const interactive = renderToStaticMarkup(<DrumSheetView text={chart} onStepClick={() => {}} />);
    expect(count(interactive, 'rect')).toBe(5);   // + one per cell of the single row
  });

  // --- The playhead (rAF, DOM-only — never React state) ----------------------

  const playhead = (container) => ({
    line: container.querySelector('[data-playhead="line"]'),
    column: container.querySelector('[data-playhead="column"]'),
  });

  // One animation frame, driven by hand so the assertions don't race the clock.
  const oneFrame = (fn) => {
    const frames = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
    const out = fn();
    act(() => { frames.shift()?.(0); });
    vi.restoreAllMocks();
    return out;
  };

  it('places both playhead marks off the audio clock without re-rendering the lane', () => {
    const chart = 'subdivision: 1\n\nHH: xxxx\n\nHH: xxxx';
    const getPlayhead = vi.fn(() => ({ countIn: false, bar: 2, stepFloat: 1.5 }));
    let container;
    oneFrame(() => {
      ({ container } = render(<DrumSheetView text={chart} playing getPlayhead={getPlayhead} />));
    });
    const { line, column } = playhead(container);
    expect(getPlayhead).toHaveBeenCalled();
    expect(line.style.display).not.toBe('none');
    // Bar 2 starts one 4-step bar (plus the inter-bar gap) into the lane, so the
    // marks sit right of bar 1 rather than at the origin…
    const x = Number(/translate\(([\d.]+)/.exec(line.getAttribute('transform'))[1]);
    expect(x).toBeGreaterThan(4 * 20);
    // …and the column quantizes to the step the line is partway through.
    expect(Number(column.getAttribute('x'))).toBe(x - 0.5 * 20);
  });

  it('parks the playhead during the count-in instead of sliding through bar 1', () => {
    let container;
    oneFrame(() => {
      ({ container } = render(
        <DrumSheetView text={'subdivision: 1\n\nHH: xxxx'} playing getPlayhead={() => ({ countIn: true, beat: 2 })} />,
      ));
    });
    const { line, column } = playhead(container);
    expect(line.style.display).toBe('none');
    expect(column.style.display).toBe('none');
  });

  it('does not run a frame loop while stopped', () => {
    const getPlayhead = vi.fn(() => ({ countIn: false, bar: 1, stepFloat: 0 }));
    render(<DrumSheetView text={'subdivision: 1\n\nHH: xxxx'} getPlayhead={getPlayhead} />);
    expect(getPlayhead).not.toHaveBeenCalled();
  });
});

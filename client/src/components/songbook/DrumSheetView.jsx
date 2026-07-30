/**
 * DrumSheetView — renders PortOS drum-kit notation (drumNotation.js) as ONE
 * continuous horizontal kit strip in hand-rolled SVG, with no engraving library
 * (the same explicit choice `ScoreSheet.jsx` makes: no VexFlow / abcjs / OSMD).
 *
 * A phone is the primary SongBook surface, and a drummer reads a groove the way
 * it is played: left to right, without end. So the whole song is a single lane
 * that scrolls horizontally under a playhead, rather than a stack of per-bar
 * grids that push the kit off the bottom of a phone screen (the pre-#3115
 * layout put ~1.5 bars above the fold on a 390px viewport). The kit labels live
 * in their own frozen column beside the scroller so "which row is the snare"
 * survives scrolling to bar 30.
 *
 * Geometry is driven off ONE constant — the grid cell size — in fixed internal
 * SVG units; the viewer's A−/A+ control scales the whole strip through the
 * `fontSizeRem` prop instead of recomputing any of it.
 *
 * THE PLAYHEAD NEVER GOES THROUGH REACT. `getPlayhead()` (useDrumPlayer) reads
 * the audio clock, and one animation-frame loop writes the results straight to
 * the DOM: a column rect on the current step, a line at the exact sub-step
 * position, and the scroller's `scrollLeft`. So a 16th-note groove repaints two
 * attributes per frame instead of re-rendering a ~2000-element SVG 8×/second.
 * The clock is also the only source that keeps moving through a rest — the
 * player's `onStep` events stall there (see `resolvePlayhead`).
 *
 * Ink comes from the PortOS theme CSS variables (`--port-text` / `--port-accent`
 * / `--port-text-muted`) applied through the `style` prop — SVG presentation
 * *attributes* don't evaluate `var()`, so `fill="var(--x)"` would silently paint
 * nothing. Same rule as ScoreSheet.
 *
 * Props:
 *   text        — the raw chart source (parsed here; the parser never throws)
 *   fontSizeRem — scales the whole strip with the viewer's A−/A+ control
 *   getPlayhead — `() => { countIn, bar, stepFloat } | null`; absent → a static
 *                 sheet with no playhead and no auto-follow
 *   playing     — gates the animation frame loop
 *   onStepClick — optional `(barIndex, step, pieceId)` for a future tap-a-cell
 *                 editor (#3115 out-of-scope); when absent the grid renders as
 *                 a plain image
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { parseDrumChart, kitPiece } from '../../lib/drumNotation.js';

// --- Geometry (internal SVG units; the strip scales via width/height + viewBox)
const CELL = 20;              // one grid step — every other measure derives from this
const ROW_H = CELL;           // one kit-piece row
const LABEL_W = 56;           // the frozen label column ("Hi-Hat", "Floor Tom")
const PAD = 6;                // padding inside the svgs
const HEAD_R = CELL * 0.3;    // notehead radius
const GHOST_R = CELL * 0.2;
const CROSS_R = CELL * 0.26;
const HEADER_H = 20;          // bar-number / section-label strip above the grid
const BAR_GAP = 6;            // breathing room between bars, inside the lane

const GRID_TOP = PAD + HEADER_H;
// Vertical centre of kit row `ri` — shared by the lane and the frozen label
// column, which have to stay in lockstep or the labels drift off their rows.
const rowCenterY = (ri) => GRID_TOP + ri * ROW_H + ROW_H / 2;

// Zoom: the A−/A+ font control drives the whole strip. 0.875rem is the viewer's
// default, so that maps to 1×.
const BASE_FONT_REM = 0.875;
const SCALE_MIN = 0.7;
const SCALE_MAX = 2.4;

// Where the playhead sits in the viewport while the sheet scrolls under it —
// far enough left that the bar you're about to play is the one you can read.
const FOLLOW_FRACTION = 0.35;

// Ink — theme CSS vars, applied via `style` (see the header note). Hoisted as
// shared objects, not built per element: the lane is ~2000 nodes on a long
// chart, and a fresh `{ fill }` literal each also defeats React's diff.
const INK = { fill: 'rgb(var(--port-text))' };
const INK_STROKE = { stroke: 'rgb(var(--port-text))' };
const INK_HOLLOW = { fill: 'none', stroke: 'rgb(var(--port-text))' };
const GRID = { stroke: 'rgb(var(--port-text-muted) / 0.35)' };
const GRID_BEAT = { stroke: 'rgb(var(--port-text-muted) / 0.7)' };
const LABEL = { fill: 'rgb(var(--port-text-muted))' };
const ACTIVE_STROKE = { stroke: 'rgb(var(--port-accent))' };
const ACTIVE_FILL = { fill: 'rgb(var(--port-accent) / 0.18)' };
const UI_FONT = 'ui-sans-serif, system-ui, sans-serif';

// Time-signature denominator → the note glyph for one BEAT at that value, for the
// tempo marking. The tempo counts notated beats, so 6/8 must read "♪ = 96", not
// "♩ = 96" — an unlisted denominator falls back to a plain "1/N" fraction rather
// than a wrong glyph.
const BEAT_GLYPH = { 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯' };

// One hit's glyph, pushed into the caller's element array. `cross` pieces
// (cymbals, hats) draw an ×; `head` pieces (drums) draw a notehead. The cell's
// own flags then modify it: a ring for an open hi-hat, a small hollow head for a
// ghost, a leading grace head for a flam, and a chevron above an accent.
const pushHit = (out, cell, piece, cx, cy, key) => {
  const cross = kitPiece(piece)?.glyph === 'cross';

  if (cell.flam) {
    // Grace note just ahead of the beat — small and offset left.
    const gx = cx - CELL * 0.3;
    out.push(cross
      ? <line key={`${key}-fl1`} x1={gx - GHOST_R} y1={cy - GHOST_R} x2={gx + GHOST_R} y2={cy + GHOST_R} style={INK_STROKE} strokeWidth={1.1} />
      : <circle key={`${key}-fl1`} cx={gx} cy={cy} r={GHOST_R} style={INK_HOLLOW} strokeWidth={1.1} />);
    if (cross) {
      out.push(<line key={`${key}-fl2`} x1={gx - GHOST_R} y1={cy + GHOST_R} x2={gx + GHOST_R} y2={cy - GHOST_R} style={INK_STROKE} strokeWidth={1.1} />);
    }
  }

  if (cross) {
    const r = cell.ghost ? GHOST_R : CROSS_R;
    const w = cell.accent ? 2.2 : 1.6;
    out.push(
      <line key={`${key}-a`} x1={cx - r} y1={cy - r} x2={cx + r} y2={cy + r} style={INK_STROKE} strokeWidth={w} strokeLinecap="round" />,
      <line key={`${key}-b`} x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} style={INK_STROKE} strokeWidth={w} strokeLinecap="round" />,
    );
    // Open hi-hat: the conventional circle around the ×.
    if (cell.open) {
      out.push(<circle key={`${key}-o`} cx={cx} cy={cy} r={r + 2.6} style={INK_HOLLOW} strokeWidth={1.2} />);
    }
  } else if (cell.ghost) {
    // Ghost note — the parenthesized/hollow head convention.
    out.push(<circle key={`${key}-h`} cx={cx} cy={cy} r={GHOST_R} style={INK_HOLLOW} strokeWidth={1.2} />);
  } else {
    out.push(<circle key={`${key}-h`} cx={cx} cy={cy} r={HEAD_R} style={INK} />);
  }

  if (cell.accent) {
    // Accent chevron above the head (the > articulation mark, rotated to sit
    // horizontally over the note). Kept inside the row: at much more than 0.36
    // of a cell up, the chevron crosses the lane line into the row above.
    const y = cy - CELL * 0.36;
    out.push(
      <path key={`${key}-ac`}
        d={`M ${cx - HEAD_R - 1} ${y - 2.4} L ${cx + HEAD_R + 1} ${y} L ${cx - HEAD_R - 1} ${y + 2.4}`}
        style={INK_HOLLOW} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />,
    );
  }
};

// The frozen kit-piece labels beside the scroller. Its own <svg> so it can't
// scroll away, sharing the lane's row geometry exactly.
const LabelColumn = ({ pieces, height, scale }) => (
  <svg
    viewBox={`0 0 ${LABEL_W} ${height}`}
    width={LABEL_W * scale}
    height={height * scale}
    aria-hidden="true"
    className="shrink-0"
    style={{ display: 'block' }}
  >
    {pieces.map((id, ri) => (
      <text key={id} x={LABEL_W - 5} y={rowCenterY(ri) + 3.5} fontSize={9.5} textAnchor="end" style={LABEL} fontFamily={UI_FONT}>
        {kitPiece(id)?.label || id}
      </text>
    ))}
  </svg>
);

// Chart problems (unknown pieces, over-long rows, bad headers). Rendered
// ALONGSIDE the sheet, never instead of it — a chart with one bad row must still
// draw the bars that parsed.
const ErrorSummary = ({ errors }) => (
  <div className="mt-3 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
    <div className="font-semibold mb-1">
      {errors.length} chart note{errors.length === 1 ? '' : 's'}
    </div>
    <ul className="list-disc pl-4 space-y-0.5">
      {errors.map((err, i) => <li key={i}>{err}</li>)}
    </ul>
  </div>
);

function DrumSheetView({
  text,
  fontSizeRem = 0.875,
  getPlayhead,
  playing = false,
  onStepClick,
  className = '',
}) {
  const chart = useMemo(() => parseDrumChart(text), [text]);
  const scrollRef = useRef(null);
  const lineRef = useRef(null);
  const columnRef = useRef(null);

  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, (fontSizeRem || BASE_FONT_REM) / BASE_FONT_REM));
  const { pieces, subdivision, stepsPerBar } = chart;
  const gridBottom = GRID_TOP + pieces.length * ROW_H;
  const height = gridBottom + PAD;

  // Every bar is exactly `stepsPerBar` wide (the parser pads every row to that
  // length), so a bar's lane position is arithmetic — no per-bar measuring.
  // Memoized as one object so the rAF loop can depend on the whole geometry.
  const { barCount, barW, barX, laneW } = useMemo(() => {
    const w = chart.stepsPerBar * CELL;
    const x = (barIndex) => PAD + (barIndex - 1) * (w + BAR_GAP);
    return {
      barCount: chart.bars.length,
      barW: w,
      barX: x,
      laneW: Math.max(PAD * 2, x(chart.bars.length + 1) - BAR_GAP + PAD),
    };
  }, [chart]);

  // One rAF loop for both playhead marks and the auto-follow scroll. All DOM
  // READS happen before any write — reading scrollLeft/clientWidth after
  // dirtying the tree in the same frame forces a synchronous layout.
  useEffect(() => {
    const line = lineRef.current;
    const column = columnRef.current;
    if (!line || !column) return undefined;
    const hide = () => {
      line.style.display = 'none';
      column.style.display = 'none';
    };
    if (!playing || !getPlayhead || typeof requestAnimationFrame !== 'function') {
      hide();
      return undefined;
    }
    let raf = requestAnimationFrame(function tick() {
      raf = requestAnimationFrame(tick);
      const pos = getPlayhead();
      // The count-in has no position on the sheet — park the marks rather than
      // sliding them through bar 1 before bar 1 is playing.
      if (!pos || pos.countIn || pos.bar > barCount) { hide(); return; }

      const el = scrollRef.current;
      const viewportW = el?.clientWidth ?? 0;
      const x = barX(pos.bar) + pos.stepFloat * CELL;

      line.style.display = '';
      column.style.display = '';
      line.setAttribute('transform', `translate(${x} 0)`);
      column.setAttribute('x', barX(pos.bar) + Math.floor(pos.stepFloat) * CELL);

      if (!el) return;
      const max = laneW * scale - viewportW;
      if (max <= 0) return;
      el.scrollLeft = Math.min(max, Math.max(0, x * scale - viewportW * FOLLOW_FRACTION));
    });
    return () => { cancelAnimationFrame(raf); hide(); };
  }, [playing, getPlayhead, barCount, barX, laneW, scale]);

  // A new chart starts from the top. Content-keyed, so a host that can show two
  // DIFFERENT records with identical charts in one mounted sheet should key this
  // component by record id (SongBookViewer does).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, [chart]);

  if (!chart.bars.length) {
    return (
      <div className={`text-sm text-gray-500 ${className}`}>
        {chart.errors.length > 0
          ? 'No readable bars in this drum chart yet — check the notes below.'
          : 'No drum chart yet — add piece rows like "HH: x x x x".'}
        {chart.errors.length > 0 && <ErrorSummary errors={chart.errors} />}
      </div>
    );
  }

  const els = [];
  let lastLabel = null;

  chart.bars.forEach((bar) => {
    const x = barX(bar.index);

    // Bar number, always; the section label only where it CHANGES. A four-bar
    // block repeating its own name over every bar is noise on a phone.
    els.push(
      <text key={`n${bar.index}`} x={x + 1} y={GRID_TOP - 8} fontSize={9} fontWeight="600" style={LABEL} fontFamily={UI_FONT}>
        {bar.index}
      </text>,
    );
    if (bar.label && bar.label !== lastLabel) {
      els.push(
        <text key={`l${bar.index}`} x={x + 14} y={GRID_TOP - 8} fontSize={9.5} style={LABEL} fontFamily={UI_FONT}>
          {bar.label}{bar.repeat > 1 ? ` ×${bar.repeat}` : ''}
        </text>,
      );
    }
    lastLabel = bar.label;

    // Lane lines for this bar's span (one per kit row, plus the bottom edge).
    for (let ri = 0; ri <= pieces.length; ri += 1) {
      const y = GRID_TOP + ri * ROW_H;
      els.push(<line key={`h${bar.index}-${ri}`} x1={x} y1={y} x2={x + barW} y2={y} style={GRID} strokeWidth={1} />);
    }

    // Vertical step lines — every `subdivision`-th is a beat boundary (heavier),
    // and the bar's own edges are heavier still.
    for (let s = 0; s <= stepsPerBar; s += 1) {
      const isEdge = s === 0 || s === stepsPerBar;
      const isBeat = s % subdivision === 0;
      els.push(
        <line key={`v${bar.index}-${s}`} x1={x + s * CELL} y1={GRID_TOP} x2={x + s * CELL} y2={gridBottom}
          style={isBeat ? GRID_BEAT : GRID} strokeWidth={isEdge ? 1.8 : (isBeat ? 1.2 : 0.6)} />,
      );
    }

    // Beat numbers under the bar-number strip. Beat 1 is skipped: the bar number
    // already sits in that corner, and "1₁" at every bar line is noise.
    for (let s = subdivision; s < stepsPerBar; s += subdivision) {
      els.push(
        <text key={`b${bar.index}-${s}`} x={x + s * CELL + CELL / 2} y={GRID_TOP - 1.5} fontSize={8}
          style={LABEL} fontFamily={UI_FONT} textAnchor="middle">
          {s / subdivision + 1}
        </text>,
      );
    }

    // Hits.
    const rowByPiece = new Map(bar.rows.map((r) => [r.piece, r]));
    pieces.forEach((id, ri) => {
      const row = rowByPiece.get(id);
      if (!row) return;
      const cy = rowCenterY(ri);
      row.cells.forEach((cell, s) => {
        if (cell.rest) return;
        pushHit(els, cell, id, x + s * CELL + CELL / 2, cy, `h${bar.index}-${id}-${s}`);
      });
    });

    // Optional tap targets (a future click-to-toggle editor); absent by default
    // so the sheet is a plain image with no stray interactive nodes.
    if (onStepClick) {
      pieces.forEach((id, ri) => {
        for (let s = 0; s < stepsPerBar; s += 1) {
          els.push(
            <rect key={`t${bar.index}-${id}-${s}`} x={x + s * CELL} y={GRID_TOP + ri * ROW_H} width={CELL} height={ROW_H}
              fill="transparent" style={{ cursor: 'pointer' }} onClick={() => onStepClick(bar.index, s, id)} />,
          );
        }
      });
    }
  });

  return (
    <div className={className} style={{ fontSize: `${fontSizeRem}rem` }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5 text-xs text-gray-500">
        <span>{chart.time.beats}/{chart.time.beatValue}</span>
        {/* The tempo counts NOTATED beats — the time-signature denominator — so
            6/8 is eighth = bpm, not quarter = bpm. Label the actual beat unit
            rather than always printing ♩, which would misstate the tempo the
            playback schedule uses (drumPlayback.buildDrumSchedule). */}
        <span>{BEAT_GLYPH[chart.time.beatValue] || `1/${chart.time.beatValue}`} = {chart.tempo}</span>
        <span>{chart.subdivision} per beat</span>
        <span>{chart.bars.length} bar{chart.bars.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex items-start">
        <LabelColumn pieces={pieces} height={height} scale={scale} />
        {/* One scroller for the whole song. `overscroll-contain` keeps a swipe
            that runs off the end of the strip from turning into a page/back
            gesture on a phone. */}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-x-auto overscroll-x-contain">
          {/* The label column is aria-hidden (a visual freeze of these same row
              names), so the kit rows are named in the strip's own label. */}
          <svg
            viewBox={`0 0 ${laneW} ${height}`}
            width={laneW * scale}
            height={height * scale}
            role="img"
            aria-label={`Drum chart — ${chart.bars.length} bar${chart.bars.length === 1 ? '' : 's'}, ${chart.time.beats}/${chart.time.beatValue} at ${chart.tempo} BPM. Kit rows: ${pieces.map((id) => kitPiece(id)?.label || id).join(', ')}`}
            style={{ display: 'block' }}
          >
            {/* Playhead column — first in the tree so the grid and glyphs paint
                over it; the line is last so it paints over them. Both are
                positioned by the rAF loop and hidden until it runs. A full-height
                line rather than a line-plus-marker: the header strip is already
                two rows of small text deep, and any glyph big enough to read
                would sit on top of the beat numbers. */}
            <rect data-playhead="column" ref={columnRef} x={0} y={GRID_TOP} width={CELL} height={gridBottom - GRID_TOP}
              style={{ ...ACTIVE_FILL, display: 'none' }} />
            {els}
            <line data-playhead="line" ref={lineRef} x1={0} y1={PAD} x2={0} y2={gridBottom}
              style={{ ...ACTIVE_STROKE, display: 'none' }} strokeWidth={1.6} />
          </svg>
        </div>
      </div>

      {chart.errors.length > 0 && <ErrorSummary errors={chart.errors} />}
    </div>
  );
}

// Every prop is a primitive or the stable `getPlayhead` callback, and the
// playhead itself never arrives as a prop — so during playback memo bails out
// and the lane is never rebuilt.
export default memo(DrumSheetView);

import { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { GripVertical, MoveDiagonal2, GripHorizontal } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { GRID_COLS, GRID_DEFAULT_H, WIDTH_TO_COLS, WIDGETS_BY_ID } from './widgetRegistry.jsx';
import useContainerWidth from '../../hooks/useContainerWidth';
import { dndTransformToCss } from '../../lib/dndTransform';

// Free-form 12-column grid with snap-to-grid drag and resize.
//
// Items: [{ id, x, y, w, h }] where x/y/w/h are integer grid units
//   - x: 0..11 (column origin)
//   - y: 0..n  (row origin; rows are uniform ROW_HEIGHT_PX tall)
//   - w: 1..12 (column span)
//   - h: 1..n  (row span)
//
// In edit mode each item exposes a top-right move handle and a bottom-right
// resize handle. Pointer events power both so the same handlers work for
// mouse and touch. Pointer capture isn't used because the drag math reads
// window-level coordinates regardless of which element the pointer crosses
// — the listener lives on `window` for the duration of the gesture.
//
// Below MOBILE_BREAKPOINT_PX the grid collapses to a single column, so x/w
// have nowhere to go — but ORDER still does. There, edit mode swaps the two
// grid handles for one reorder handle that sorts the stack via dnd-kit (the
// same PointerSensor/KeyboardSensor pairing as every other sortable list in
// the app); on drop the whole grid is re-flowed so its reading order matches
// the new stack order (`reflowToOrder`). The free-form 2-D drag stays
// hand-rolled — arbitrary grid placement isn't what a sortable list does —
// but the 1-D case is exactly dnd-kit's job, and going through it is what
// buys touch, keyboard, multi-pointer and edge auto-scroll for free.
//
// Collision policy after drag/resize: pin the moved item at its dropped
// position, then slot every other item into the smallest y that doesn't
// collide with anything already placed (top-left items processed first).
// Tetris-style compaction — same feel as react-grid-layout / gridstack.

const ROW_HEIGHT_PX = 80;
const GAP_PX = 16;
const MIN_W = 2;
const MIN_H = 2;
// Mobile breakpoint: below this width the grid collapses to a single column
// stacked vertically. Free-form move/resize is off there — a phone has no
// room for positional editing — but drag-to-reorder is on (see above).
// Deliberately NOT exported: a caller that needs to know which affordance is
// live gets it from `onLayoutModeChange`, because this threshold is measured
// against the CONTAINER and re-deriving it outside would read the viewport.
const MOBILE_BREAKPOINT_PX = 640;

function getColWidth(containerWidth) {
  return (containerWidth - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
}

// Reading order: top-to-bottom, then left-to-right. This is the order the
// single-column mobile stack renders in, and the order `reflowToOrder`
// consumes. `placeAndCompact` returns the moved item first regardless of
// where it landed, so grid array order can't be trusted for this.
function byReadingOrder(a, b) {
  return a.y - b.y || a.x - b.x;
}

function rectFor(item, colWidth) {
  return {
    left: item.x * (colWidth + GAP_PX),
    top: item.y * (ROW_HEIGHT_PX + GAP_PX),
    width: item.w * colWidth + (item.w - 1) * GAP_PX,
    height: item.h * ROW_HEIGHT_PX + (item.h - 1) * GAP_PX,
  };
}

function overlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function sameRect(a, b) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

// Everything that differs between the three handles, on one row each. `kind`
// already discriminates them, so icon/size/placement hang off it rather than
// travelling as separate props.
const HANDLE_KINDS = {
  move: { label: 'Move', Icon: GripVertical, size: 14, className: 'top-1.5 right-1.5 p-1 cursor-move' },
  resize: { label: 'Resize', Icon: MoveDiagonal2, size: 14, className: 'bottom-1 right-1 p-1 cursor-se-resize' },
  reorder: {
    label: 'Reorder',
    Icon: GripHorizontal,
    size: 18,
    // Fatter target than the desktop pair: this one is only ever hit by a thumb.
    className: 'top-1.5 right-1.5 p-2.5 cursor-grab active:cursor-grabbing',
  },
};

// Shared drag/resize/reorder handle. `handleProps` is how dnd-kit's sortable
// attributes + listeners reach the reorder variant; the two grid handles pass
// their own onPointerDown instead. `touchAction: 'none'` is what makes any of
// them work under a finger — without it the browser claims the pointer stream
// for scrolling.
function DragHandle({ kind, item, onPointerDown, handleProps }) {
  const { label, Icon, size, className } = HANDLE_KINDS[kind];
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      // The registry label, not the raw id — this is read aloud.
      aria-label={`${label} ${WIDGETS_BY_ID[item.id]?.label ?? item.id}`}
      className={`absolute z-20 bg-port-bg/90 border border-port-border rounded text-gray-300 hover:text-white hover:border-port-accent ${className}`}
      style={{ touchAction: 'none' }}
      {...handleProps}
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  );
}

// Pin the moved item at its dropped position, then slide every other item
// upward to the smallest y that doesn't collide with anything already
// placed. Combines collision-resolve and compact in one pass: the moved
// item goes first (so it acts as an obstacle for everyone else) and the
// rest are processed in current (y, x) order so top-left items keep
// precedence. Returns a new array — never mutates input.
function placeAndCompact(items, movedId) {
  const moved = items.find((i) => i.id === movedId);
  if (!moved) return items.map((it) => ({ ...it }));
  const rest = items.filter((i) => i.id !== movedId).sort(byReadingOrder);
  const placed = [{ ...moved }];
  for (const item of rest) {
    let y = 0;
    while (placed.some((p) => overlaps({ ...item, y }, p))) y += 1;
    placed.push({ ...item, y });
  }
  return placed;
}

// Auto-place a new widget at the bottom of the grid, left-aligned. Used when
// LayoutEditor adds a widget to a layout without specifying coordinates.
export function placeNewWidget(items, widgetId) {
  const meta = WIDGETS_BY_ID[widgetId];
  const w = WIDTH_TO_COLS[meta?.width] ?? 4;
  const h = meta?.defaultH ?? GRID_DEFAULT_H;
  const bottom = items.reduce((max, it) => Math.max(max, it.y + it.h), 0);
  return [...items, { id: widgetId, x: 0, y: bottom, w, h }];
}

// Row-flow items into the 12-column grid following `orderedIds`, preserving
// each item's w/h and dropping anything not in the order. This is how a mobile
// reorder becomes a grid: the single-column stack has no x/y to drop onto, so
// the new stack order is re-flowed into fresh coordinates. Items that already
// sit in flow order (the common case) come back with the same coordinates.
export function reflowToOrder(items, orderedIds = items.map((it) => it.id)) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const flowed = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxH = 0;
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (!item) continue;
    const w = Math.min(item.w, GRID_COLS);
    if (cursorX + w > GRID_COLS) {
      cursorX = 0;
      cursorY += rowMaxH;
      rowMaxH = 0;
    }
    flowed.push({ ...item, x: cursorX, y: cursorY, w });
    cursorX += w;
    rowMaxH = Math.max(rowMaxH, item.h);
  }
  return flowed;
}

// Synthesize a row-flow grid from a plain widget id list. Mirrors the
// previous CSS-grid layout so unmigrated layouts open in the same visual
// arrangement they had before the grid feature shipped.
export function synthesizeGrid(widgetIds) {
  return reflowToOrder(widgetIds.flatMap((id) => {
    const meta = WIDGETS_BY_ID[id];
    if (!meta) return [];
    return [{ id, w: WIDTH_TO_COLS[meta.width] ?? 4, h: meta.defaultH ?? GRID_DEFAULT_H }];
  }));
}

// Reconcile a saved grid against the visible widget list. Adds positions for
// any widgets missing from the grid (auto-placed at the bottom) and drops
// grid entries whose widget is no longer in the layout (gated off, deleted,
// etc.). Keeps the renderer's input always coherent with what should display.
export function reconcileGrid(grid, visibleIds) {
  const visible = new Set(visibleIds);
  const present = new Set();
  let kept = [];
  for (const item of grid) {
    if (!visible.has(item.id)) continue;
    if (present.has(item.id)) continue;
    present.add(item.id);
    kept.push(item);
  }
  for (const id of visibleIds) {
    if (present.has(id)) continue;
    kept = placeNewWidget(kept, id);
  }
  return kept;
}

// Reading order of a grid — what the mobile stack shows, and what a layout's
// `widgets` array should agree with so LayoutEditor lists them as displayed.
export function readingOrderIds(grid) {
  return [...grid].sort(byReadingOrder).map((it) => it.id);
}

// One dashboard cell. Split out (and memoized) because every indicator tick of
// a drag re-renders the grid, and without this each tick would re-run
// `renderItem` for all ~12 widgets to move one card.
const GridCell = memo(function GridCell({
  item, isMobile, editable, sortable, colWidth, isGridDragging, gridDragActive,
  onStartGridDrag, renderItem,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !sortable,
  });

  const itemStyle = isMobile
    ? { transform: dndTransformToCss(transform), transition, opacity: isDragging ? 0.4 : undefined }
    : rectFor(item, colWidth);
  const itemClass = isMobile
    ? 'w-full'
    : `absolute ${isGridDragging ? 'opacity-40' : ''} ${gridDragActive ? '' : 'transition-[left,top,width,height] duration-150'}`;
  const innerClass = isMobile
    ? 'relative'
    : `relative w-full h-full overflow-hidden rounded-xl ${editable ? 'ring-1 ring-port-border' : ''}`;

  return (
    <div ref={setNodeRef} data-widget-id={item.id} className={itemClass} style={itemStyle}>
      <div className={innerClass}>
        {renderItem(item)}
        {editable && !isMobile && (
          <>
            <DragHandle kind="move" item={item} onPointerDown={(e) => onStartGridDrag(e, item, 'move')} />
            <DragHandle kind="resize" item={item} onPointerDown={(e) => onStartGridDrag(e, item, 'resize')} />
          </>
        )}
        {sortable && (
          <DragHandle kind="reorder" item={item} handleProps={{ ...attributes, ...listeners }} />
        )}
      </div>
    </div>
  );
});

export default function DashboardGrid({ items, editable, onChange, onLayoutModeChange, renderItem }) {
  const [containerRef, containerWidth] = useContainerWidth();
  // Drag state lives outside React when active to avoid a setState on every
  // pointermove (would spam re-renders of every widget). React only learns
  // about the new ghost when we call setDragGhost, throttled by RAF.
  const dragRef = useRef(null);
  const [dragGhost, setDragGhost] = useState(null);

  const isMobile = containerWidth > 0 && containerWidth < MOBILE_BREAKPOINT_PX;
  // The mobile/desktop seam is measured off the CONTAINER, so a caller that
  // wants to describe the active affordance has to be told — a CSS `sm:`
  // breakpoint reads the viewport and disagrees on a padded page.
  useEffect(() => {
    if (containerWidth > 0) onLayoutModeChange?.(isMobile);
  }, [isMobile, containerWidth, onLayoutModeChange]);

  // Render in reading order always, not grid-array order: the mobile stack
  // depends on it, and on desktop it keeps DOM/tab order matching what the
  // eye sees. Keyed children survive reordering, so widget state is safe.
  const ordered = useMemo(() => [...items].sort(byReadingOrder), [items]);
  const orderedIds = useMemo(() => ordered.map((it) => it.id), [ordered]);

  const totalRows = useMemo(
    () => items.reduce((max, it) => Math.max(max, it.y + it.h), 0),
    [items]
  );
  const containerHeight = totalRows * (ROW_HEIGHT_PX + GAP_PX);

  const startDrag = useCallback((e, item, kind) => {
    if (!editable || isMobile) return;
    // Prevent text selection mid-drag. preventDefault on the handle's
    // pointerdown is enough because the listener lives on window and we
    // never let the pointer leave the gesture.
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      id: item.id,
      kind,
      startPointer: { x: e.clientX, y: e.clientY },
      startItem: { ...item },
      ghost: { ...item },
    };
    setDragGhost({ ...item });
  }, [editable, isMobile]);

  useEffect(() => {
    if (!dragGhost) return undefined;
    const colWidth = getColWidth(containerWidth);
    let raf = 0;

    const onPointerMove = (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startPointer.x;
      const dy = e.clientY - drag.startPointer.y;
      const colStep = colWidth + GAP_PX;
      const rowStep = ROW_HEIGHT_PX + GAP_PX;

      let next;
      if (drag.kind === 'move') {
        const newX = Math.max(0, Math.min(GRID_COLS - drag.startItem.w, Math.round(drag.startItem.x + dx / colStep)));
        const newY = Math.max(0, Math.round(drag.startItem.y + dy / rowStep));
        next = { ...drag.startItem, x: newX, y: newY };
      } else {
        const newW = Math.max(MIN_W, Math.min(GRID_COLS - drag.startItem.x, Math.round(drag.startItem.w + dx / colStep)));
        const newH = Math.max(MIN_H, Math.round(drag.startItem.h + dy / rowStep));
        next = { ...drag.startItem, w: newW, h: newH };
      }
      // Snap dedup: pointermove fires at 200+ Hz, but `next` only changes
      // when the cursor crosses a snap boundary. Skip the React update
      // when we're still inside the same snap cell — saves ~60 widget
      // re-renders per drag and keeps the rAF callback a no-op.
      if (sameRect(drag.ghost, next)) return;
      drag.ghost = next;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (dragRef.current) setDragGhost({ ...dragRef.current.ghost });
        });
      }
    };

    const finish = (commit) => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      const drag = dragRef.current;
      dragRef.current = null;
      setDragGhost(null);
      if (!drag || !commit) return;
      // Skip the write entirely when nothing actually changed — avoids a
      // 200 OK on every accidental click on the drag handle.
      if (sameRect(drag.startItem, drag.ghost)) return;
      const updated = items.map((it) => (it.id === drag.id ? { ...it, ...drag.ghost } : it));
      onChange(placeAndCompact(updated, drag.id));
    };

    const onPointerUp = () => finish(true);
    const onPointerCancel = () => finish(false);

    // Passive listeners — none of these handlers call preventDefault.
    // preventDefault on the pointerdown (in startDrag) is enough to suppress
    // text selection mid-drag.
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerCancel, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      if (raf) cancelAnimationFrame(raf);
    };
  // dragGhost in the deps array re-installs the listeners only when the
  // gesture starts/ends — pointermove updates dragRef.current directly.
  }, [dragGhost ? 'active' : 'idle', items, onChange, containerWidth]);

  // A short activation distance keeps a tap on the handle from registering as
  // a drag; the keyboard sensor is what makes the handle usable without one.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onSortEnd = useCallback(({ active, over }) => {
    if (!over || active.id === over.id) return;
    const from = orderedIds.indexOf(active.id);
    const to = orderedIds.indexOf(over.id);
    if (from < 0 || to < 0) return;
    onChange(reflowToOrder(items, arrayMove(orderedIds, from, to)));
  }, [orderedIds, items, onChange]);

  const sortable = editable && isMobile;
  const colWidth = isMobile ? 0 : getColWidth(containerWidth);

  return (
    // DndContext/SortableContext render no DOM of their own, so they can wrap
    // unconditionally — which matters, because a conditional wrapper would
    // remount every widget on a breakpoint cross (see the note below).
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSortEnd}>
      <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
        {/* Single render tree across mobile and desktop — only the
            className/style toggle. If we returned a different JSX shape per
            mode (separate mobile branch with shallower wrappers), React would
            unmount every widget on the breakpoint cross, wiping in-progress
            form input. Rotating an iPhone from portrait (~390px) to landscape
            (~844px) crosses MOBILE_BREAKPOINT_PX, so structural divergence
            here = "my Quick Capture text vanished when I rotated." Keep the
            wrapper depth identical and let CSS handle the rest. */}
        <div
          ref={containerRef}
          className={isMobile ? 'space-y-4' : 'relative w-full'}
          style={isMobile ? undefined : { height: containerWidth ? containerHeight : 'auto', minHeight: '4rem' }}
        >
          {ordered.map((item) => (
            <GridCell
              key={item.id}
              item={item}
              isMobile={isMobile}
              editable={editable && containerWidth > 0}
              sortable={sortable}
              colWidth={colWidth}
              isGridDragging={!isMobile && dragGhost?.id === item.id}
              gridDragActive={Boolean(dragGhost)}
              onStartGridDrag={startDrag}
              renderItem={renderItem}
            />
          ))}

          {/* Drop preview during the free-form drag — outline showing where
              the item will land after snap. Pointer-events:none so it never
              intercepts the gesture. */}
          {!isMobile && dragGhost && containerWidth > 0 && (
            <div
              className="absolute pointer-events-none border-2 border-dashed border-port-accent rounded-xl bg-port-accent/10 z-30"
              style={rectFor(dragGhost, colWidth)}
            />
          )}
        </div>
      </SortableContext>
    </DndContext>
  );
}

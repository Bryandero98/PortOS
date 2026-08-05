import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Stub @dnd-kit/core's DndContext so drag-end can be fired imperatively. The
// real implementation needs DOM measurement + pointer sensors, which jsdom
// doesn't provide reliably — and the behavior under test is "what does the
// grid do when onDragEnd reports these ids," which is all driven through the
// callback captured here. Same shape as InfluenceChipsInput.test.jsx.
const dndState = { onDragEnd: null };

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }) => {
    dndState.onDragEnd = onDragEnd;
    return <>{children}</>;
  },
  KeyboardSensor: function KeyboardSensorStub() {},
  PointerSensor: function PointerSensorStub() {},
  closestCenter: () => null,
  useSensor: () => null,
  useSensors: () => [],
}));

// Keep arrayMove real (the ordering invariant is the point) but stub the
// hook + provider, which need a live DndContext.
vi.mock('@dnd-kit/sortable', async () => {
  const actual = await vi.importActual('@dnd-kit/sortable');
  return {
    ...actual,
    SortableContext: ({ children }) => <>{children}</>,
    sortableKeyboardCoordinates: () => null,
    verticalListSortingStrategy: null,
    useSortable: ({ disabled }) => ({
      attributes: { 'data-sortable-disabled': String(Boolean(disabled)) },
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      transition: null,
      isDragging: false,
    }),
  };
});

const DashboardGrid = (await import('./DashboardGrid.jsx')).default;
const { reflowToOrder, synthesizeGrid, reconcileGrid, readingOrderIds } = await import('./DashboardGrid.jsx');

// jsdom has no ResizeObserver, and useContainerWidth (which decides mobile vs
// desktop) depends on one. Stand in a fake reporting whatever width the test
// asked for.
let mockWidth = 1200;

class FakeResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([{ contentRect: { width: mockWidth } }]); }
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  dndState.onDragEnd = null;
});

const THREE = [
  { id: 'a', x: 0, y: 0, w: 12, h: 2 },
  { id: 'b', x: 0, y: 2, w: 12, h: 2 },
  { id: 'c', x: 0, y: 4, w: 12, h: 2 },
];

function renderGrid(items = THREE) {
  const onChange = vi.fn();
  render(
    <DashboardGrid
      items={items}
      editable
      onChange={onChange}
      renderItem={(item) => <div data-testid={`widget-${item.id}`}>{item.id}</div>}
    />
  );
  return onChange;
}

describe('reflowToOrder', () => {
  it('renumbers coordinates to match the requested order, keeping w/h', () => {
    const flowed = reflowToOrder(THREE, ['c', 'a', 'b']);
    expect(flowed.map((it) => it.id)).toEqual(['c', 'a', 'b']);
    expect(flowed.map((it) => it.y)).toEqual([0, 2, 4]);
    expect(flowed.every((it) => it.w === 12 && it.h === 2)).toBe(true);
  });

  it('packs items that fit side by side into the same row', () => {
    const items = [
      { id: 'a', x: 0, y: 0, w: 6, h: 3 },
      { id: 'b', x: 6, y: 0, w: 6, h: 2 },
      { id: 'c', x: 0, y: 3, w: 6, h: 2 },
    ];
    expect(reflowToOrder(items, ['b', 'a', 'c'])).toEqual([
      { id: 'b', x: 0, y: 0, w: 6, h: 2 },
      { id: 'a', x: 6, y: 0, w: 6, h: 3 },
      { id: 'c', x: 0, y: 3, w: 6, h: 2 },
    ]);
  });

  it('leaves an already-in-flow layout untouched, and defaults to the given order', () => {
    expect(reflowToOrder(THREE, ['a', 'b', 'c'])).toEqual(THREE);
    expect(reflowToOrder(THREE)).toEqual(THREE);
  });

  it('drops ids with no matching item and ignores items absent from the order', () => {
    expect(reflowToOrder(THREE, ['b', 'ghost'])).toEqual([{ id: 'b', x: 0, y: 0, w: 12, h: 2 }]);
  });

  it('still flows a widget whose stored width exceeds the grid', () => {
    expect(reflowToOrder([{ id: 'a', x: 0, y: 0, w: 20, h: 2 }], ['a']))
      .toEqual([{ id: 'a', x: 0, y: 0, w: 12, h: 2 }]);
  });
});

describe('readingOrderIds', () => {
  it('sorts top-to-bottom then left-to-right without mutating the input', () => {
    const grid = [
      { id: 'c', x: 0, y: 4, w: 6, h: 2 },
      { id: 'b', x: 6, y: 0, w: 6, h: 2 },
      { id: 'a', x: 0, y: 0, w: 6, h: 2 },
    ];
    expect(readingOrderIds(grid)).toEqual(['a', 'b', 'c']);
    expect(grid[0].id).toBe('c');
  });
});

describe('synthesizeGrid', () => {
  it('skips ids that are not registered widgets', () => {
    expect(synthesizeGrid(['not-a-widget'])).toEqual([]);
  });
});

describe('reconcileGrid', () => {
  it('drops hidden widgets and appends newly visible ones', () => {
    expect(reconcileGrid(THREE, ['a', 'c']).map((it) => it.id)).toEqual(['a', 'c']);
  });
});

describe('DashboardGrid mobile reorder', () => {
  beforeEach(() => { mockWidth = 400; });

  it('exposes a reorder handle per widget, and no grid move/resize handles', () => {
    renderGrid();
    expect(screen.getByLabelText('Reorder a')).toBeInTheDocument();
    expect(screen.getByLabelText('Reorder c')).toBeInTheDocument();
    expect(screen.queryByLabelText('Move a')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Resize a')).not.toBeInTheDocument();
  });

  it('enables the sortable so the handle can actually start a drag', () => {
    renderGrid();
    expect(screen.getByLabelText('Reorder a')).toHaveAttribute('data-sortable-disabled', 'false');
  });

  it('reflows the grid to the new order when a widget is dropped on another', () => {
    const onChange = renderGrid();
    dndState.onDragEnd({ active: { id: 'a' }, over: { id: 'c' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.map((it) => it.id)).toEqual(['b', 'c', 'a']);
    expect(next.map((it) => it.y)).toEqual([0, 2, 4]);
  });

  it('reads the drag against reading order, not grid-array order', () => {
    // placeAndCompact hoists the moved item to the front of the array, so a
    // saved grid routinely arrives out of visual order.
    const onChange = renderGrid([
      { id: 'c', x: 0, y: 4, w: 12, h: 2 },
      { id: 'a', x: 0, y: 0, w: 12, h: 2 },
      { id: 'b', x: 0, y: 2, w: 12, h: 2 },
    ]);
    expect(screen.getAllByTestId(/^widget-/).map((el) => el.textContent)).toEqual(['a', 'b', 'c']);

    dndState.onDragEnd({ active: { id: 'c' }, over: { id: 'a' } });
    expect(onChange.mock.calls[0][0].map((it) => it.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not write when the drag ends on itself or outside the list', () => {
    const onChange = renderGrid();
    dndState.onDragEnd({ active: { id: 'a' }, over: { id: 'a' } });
    dndState.onDragEnd({ active: { id: 'a' }, over: null });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DashboardGrid desktop', () => {
  beforeEach(() => { mockWidth = 1200; });

  it('keeps the move/resize handles and hides the reorder handle', () => {
    renderGrid();
    expect(screen.getByLabelText('Move a')).toBeInTheDocument();
    expect(screen.getByLabelText('Resize a')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reorder a')).not.toBeInTheDocument();
  });
});

describe('DashboardGrid scroll target', () => {
  beforeEach(() => { mockWidth = 1200; });

  // The Dashboard scrolls a just-added widget into view by querying
  // [data-widget-id="…"]; that attribute is the scroll-target contract.
  it('tags each cell with its widget id', () => {
    renderGrid();
    expect(document.querySelector('[data-widget-id="a"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-id="b"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-id="c"]')).not.toBeNull();
  });
});

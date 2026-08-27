import { describe, it, expect } from 'vitest';
import * as widgetRegistry from './widgetRegistry.jsx';

describe('widgetRegistry', () => {
  it('exports WIDGETS and WIDGETS_BY_ID', () => {
    expect(Array.isArray(widgetRegistry.WIDGETS)).toBe(true);
    expect(widgetRegistry.WIDGETS.length).toBeGreaterThan(0);
    expect(widgetRegistry.WIDGETS_BY_ID).toBeDefined();

    for (const widget of widgetRegistry.WIDGETS) {
      expect(widget.id).toBeDefined();
      expect(widget.label).toBeDefined();
      expect(widget.Component).toBeDefined();
      expect(widget.width).toBeDefined();
      expect(widgetRegistry.WIDGETS_BY_ID[widget.id]).toBe(widget);
    }
  });

  it('exports FALLBACK_LAYOUT with expected shape', () => {
    expect(widgetRegistry.FALLBACK_LAYOUT).toEqual({
      id: '_fallback',
      name: 'Default (offline)',
      builtIn: true,
      widgets: ['apps', 'cos', 'upcoming-tasks', 'system-health'],
    });
  });

  it('exports grid conversion constants', () => {
    expect(widgetRegistry.WIDTH_TO_COLS).toEqual({
      full: 12,
      half: 6,
      third: 4,
      quarter: 3,
    });
    expect(widgetRegistry.GRID_COLS).toBe(12);
    expect(widgetRegistry.GRID_DEFAULT_H).toBe(4);
  });

  it('does not export deprecated WIDTH_CLASS', () => {
    expect(widgetRegistry.WIDTH_CLASS).toBeUndefined();
  });
});

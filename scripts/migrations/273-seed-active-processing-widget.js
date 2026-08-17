import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const WIDGET_ID = 'active-processing';

const appendToLayout = (layout) => {
  if (!layout || typeof layout !== 'object') return false;
  if (!['default', 'ops'].includes(layout.id)) return false;
  const widgets = Array.isArray(layout.widgets) ? layout.widgets : [];
  const grid = Array.isArray(layout.grid) ? layout.grid : [];
  if (widgets.includes(WIDGET_ID)) return false;
  layout.widgets = [...widgets, WIDGET_ID];
  const maxOrder = grid.reduce((max, item) => Math.max(max, Number.isFinite(item?.order) ? item.order : -1), -1);
  layout.grid = [...grid, { id: WIDGET_ID, x: 0, w: 6, order: maxOrder + 1, h: 5 }];
  return true;
};

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: 'migration 273' });
    if (!result.ok) return { updated: 0, reason: result.reason };
    let updated = 0;
    for (const layout of result.doc.layouts) if (appendToLayout(layout)) updated += 1;
    if (updated) await writeLayoutsDoc(result.path, result.doc);
    return { updated };
  },
};

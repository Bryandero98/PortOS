/**
 * Seed the deterministic product-engagement action widget into the built-in
 * Everything and Morning Review layouts. Custom/user layouts are intentionally
 * untouched: the layout editor is the user's source of truth for those.
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const LABEL = 'migration 297';
const TARGET_LAYOUTS = new Set(['default', 'morning-review']);
const WIDGET_ID = 'daily-actions';

function applyToLayout(layout) {
  if (!layout || !TARGET_LAYOUTS.has(layout.id) || !Array.isArray(layout.widgets)) return false;
  const hasWidget = layout.widgets.includes(WIDGET_ID);
  const hasGridEntry = Array.isArray(layout.grid) && layout.grid.some((item) => item?.id === WIDGET_ID);
  if (hasWidget && hasGridEntry) return false;

  if (!hasWidget) layout.widgets = [WIDGET_ID, ...layout.widgets];
  const existingGrid = (Array.isArray(layout.grid) ? layout.grid : []).filter((item) => item?.id !== WIDGET_ID);
  const shifted = existingGrid.map((item, index) => ({
    ...item,
    order: Number.isFinite(item?.order) ? item.order + 1 : index + 1,
  }));
  layout.grid = [
    { id: WIDGET_ID, x: 0, w: 12, order: 0, h: 4 },
    ...shifted,
  ];
  return true;
}

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: LABEL });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;
    let updated = 0;
    for (const layout of doc.layouts) {
      if (applyToLayout(layout)) updated += 1;
    }
    if (updated === 0) return { updated: 0, reason: 'already-applied' };
    await writeLayoutsDoc(path, doc);
    console.log(`📦 ${LABEL}: seeded daily action widget in ${updated} built-in dashboard layout(s).`);
    return { updated };
  },
};

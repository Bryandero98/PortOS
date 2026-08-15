/**
 * Convert persisted dashboard grids from the two-coordinate shape
 * `{ id, x, y, w, h, fixedH? }` to the single-sequence shape
 * `{ id, x, w, order, h?, fixedH? }` (issue #4133).
 *
 * Background:
 *   Dashboard cells have been content-measured and pixel-packed since the
 *   auto-height grid shipped, so the stored `y` stopped being a position and
 *   became nothing but a reading/packing order that the renderer had to keep
 *   agreeing with the pack on every gesture. This migration retires it: each
 *   layout's grid is sorted into its existing reading order (top-to-bottom,
 *   then left-to-right) and renumbered as a dense `order`, so a converted file
 *   opens in exactly the arrangement the user last saw.
 *
 *   `h` is preserved untouched — it is still the first-paint fallback (and
 *   what a client too old to know about `fixedH` renders), which is why it
 *   survives the conversion at all.
 *
 * Idempotent: a grid whose every entry already carries `order` and no `y` is
 * left alone. `server/services/dashboardLayouts.js` also derives `order` from
 * `y` on read, so an install that has not run this migration (or a restored
 * pre-#4133 backup) still gets usable geometry — this just makes the file on
 * disk say what the renderer means.
 */

import { readLayoutsDoc, writeLayoutsDoc } from './_lib.js';

const LABEL = 'migration 269';

const intOr = (v, fallback) => (Number.isFinite(v) ? Math.floor(v) : fallback);

// Already-converted entries carry `order` and no `y`. Both halves matter: a
// hand-merged file can carry `order` alongside a stale `y`, and that still
// needs the rewrite so the dead coordinate stops shipping.
const isConverted = (grid) =>
  grid.every((g) => g && typeof g === 'object' && Number.isFinite(g.order) && g.y === undefined);

// Reading order — top-to-bottom, then left-to-right — is the order the
// renderer already packed these cells in, so replaying it preserves the
// layout the user last saw.
function toOrderedGrid(grid) {
  return grid
    .map((g, idx) => ({ g, idx, y: intOr(g?.y, 0), x: intOr(g?.x, 0) }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.idx - b.idx)
    .map(({ g }, order) => {
      const next = { id: g.id, x: intOr(g.x, 0), w: intOr(g.w, 1), order };
      if (Number.isFinite(g.h)) next.h = Math.floor(g.h);
      if (g.fixedH === true) next.fixedH = true;
      return next;
    });
}

function applyToLayout(layout) {
  if (!layout || typeof layout !== 'object') return false;
  if (!Array.isArray(layout.grid) || layout.grid.length === 0) return false;
  // A non-object entry is unusable to the renderer either way; drop it here
  // rather than carrying `undefined` ids into the converted shape.
  const grid = layout.grid.filter((g) => g && typeof g === 'object' && typeof g.id === 'string');
  if (grid.length === layout.grid.length && isConverted(grid)) return false;
  layout.grid = toOrderedGrid(grid);
  return true;
}

export default {
  async up({ rootDir }) {
    const result = await readLayoutsDoc({ rootDir, label: LABEL });
    if (!result.ok) return { updated: 0, reason: result.reason };
    const { doc, path } = result;

    let touched = 0;
    for (const layout of doc.layouts) {
      if (applyToLayout(layout)) touched += 1;
    }

    if (touched === 0) {
      console.log(`📦 ${LABEL}: dashboard grids already use \`order\` — nothing to convert.`);
      return { updated: 0, reason: 'already-applied' };
    }

    await writeLayoutsDoc(path, doc);
    console.log(`📦 ${LABEL}: converted ${touched} dashboard layout grid(s) to the order-only shape.`);
    return { updated: touched };
  },
};

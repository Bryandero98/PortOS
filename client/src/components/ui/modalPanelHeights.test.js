import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

/**
 * Migration pin for issue #5665.
 *
 * `Modal.jsx` clamps its panel to the *visible* viewport (`max-h-dvh-cap` plus
 * a per-align `--dvh-inset`). A call site that re-adds its own `max-h-[NNvh]`
 * defeats that: the overlay is `fixed inset-0` — the small viewport under iOS
 * Safari's retractable chrome — and centres with `items-center`, so a taller
 * panel has its overflow split top and bottom and the dialog loses both its
 * title and its Save/Cancel row off-screen. On the long forms that also set
 * `closeOnEsc={false}` / `closeOnBackdrop={false}` there is then no way out.
 *
 * A caller that genuinely wants a *shorter* panel sets the cap instead:
 * `panelClassName="… [--dvh-cap:50dvh]"`, which still resolves against the
 * dynamic viewport.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// panelClassName="…" / {`…`} / {'…'} — the three literal forms in the tree.
const PANEL_CLASS_RE = /panelClassName=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g;
const RAW_VH_RE = /max-h-\[[\d.]+vh\]/;

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.jsx?$/.test(entry) && !/\.(test|spec)\.jsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('Modal panel heights', () => {
  it('has no call site passing a raw viewport-height clamp in panelClassName', () => {
    const offenders = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('panelClassName')) continue;
      for (const match of source.matchAll(PANEL_CLASS_RE)) {
        const value = match[1] ?? match[2] ?? match[3] ?? '';
        if (RAW_VH_RE.test(value)) offenders.push(`${relative(SRC_ROOT, file)}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans a representative set of Modal call sites (guards the regex itself)', () => {
    // A collector that silently matched nothing would make the assertion above
    // vacuously green, so pin the sweep's own reach.
    const withPanelClass = collectSourceFiles(SRC_ROOT)
      .filter((file) => readFileSync(file, 'utf8').includes('panelClassName='));
    expect(withPanelClass.length).toBeGreaterThan(20);
  });
});

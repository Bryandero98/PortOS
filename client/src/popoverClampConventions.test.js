/**
 * Repo-wide viewport clamp on fixed-width popovers.
 *
 * `Layout`'s root shell is `w-full max-w-full overflow-x-hidden`, so an
 * absolutely-positioned panel wider than the viewport is CLIPPED, not made
 * scrollable — the overflowing edge is simply unreachable. A filter panel
 * declared `w-96` (384px) and anchored `right-3` is therefore wider than a 360px
 * phone screen, and its whole left column of controls sits permanently off the
 * left edge with nothing to scroll to (issue #5686).
 *
 * The rule: a class string that positions an element `absolute` AND fixes its
 * width with a bare `w-<n>` of 64 (16rem / 256px) or more must also carry a
 * `max-w-*` clamp. The tree's canonical form is `max-w-[calc(100vw-1rem)]`
 * (`components/pipeline/arcCanvas/VerifyScopeTooltip.jsx`), which keeps a fixed
 * 8px gutter at every width rather than a proportional one that collapses on
 * small screens — but any `max-w-*` satisfies the guard, because a panel that
 * declares one has demonstrably been through the narrow case.
 *
 * Deliberately NOT flagged:
 *  - `min-w-*` / `max-w-*` tokens, which are not a fixed width (`sm:min-w-80` on
 *    a `left-3 right-3` media overlay is correct as written).
 *  - `fixed` positioning, which escapes the shell's overflow box.
 *  - Widths below `w-64`, which fit inside the narrowest viewport the app
 *    targets even with a gutter.
 *
 * Scoped to git-tracked non-test sources; comments are masked first so a doc
 * block quoting an example class string is documentation, not markup.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';
import { lineOf, maskComments, stringLiterals } from './test/classNameScan.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Tailwind's numeric width scale is in 0.25rem steps: 64 → 16rem → 256px. */
const MIN_CLAMPED_WIDTH = 64;
const VARIANT = String.raw`(?:[\w@[\]().\-/]+:)*`;
// `w-64`, `sm:w-96` — but never `min-w-80` / `max-w-96`, whose token doesn't
// start at `w-` once the variant prefixes are consumed.
const FIXED_WIDTH = new RegExp(String.raw`^${VARIANT}w-(\d+)$`);
const ABSOLUTE = new RegExp(String.raw`^${VARIANT}absolute$`);
const MAX_WIDTH = new RegExp(String.raw`^${VARIANT}max-w-`);

function widestFixedWidth(tokens) {
  return tokens.reduce((widest, token) => {
    const match = FIXED_WIDTH.exec(token);
    return match ? Math.max(widest, Number(match[1])) : widest;
  }, 0);
}

function violationsIn(rawSource, file) {
  const source = maskComments(rawSource);
  return stringLiterals(source)
    .filter(({ value }) => {
      const tokens = value.split(/\s+/).filter(Boolean);
      if (!tokens.some((token) => ABSOLUTE.test(token))) return false;
      if (widestFixedWidth(tokens) < MIN_CLAMPED_WIDTH) return false;
      return !tokens.some((token) => MAX_WIDTH.test(token));
    })
    .map(({ value, index }) => `${file}:${lineOf(source, index)} — "${value.trim()}"`);
}

const findViolations = (file) =>
  violationsIn(readFileSync(join(CLIENT_ROOT, file), 'utf8'), file);

describe('popover viewport-clamp conventions', () => {
  const files = trackedSourceFiles(CLIENT_ROOT);

  it('scans a populated client tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // Without this the suite would still pass if the detector silently stopped
  // matching anything — a green tree-wide guard proves nothing on its own.
  it('flags an unclamped fixed-width popover and clears every safe form', () => {
    const flagged = (markup) => violationsIn(`<div className="${markup}" />`, 'probe.jsx').length;
    expect(flagged('absolute top-12 right-3 z-20 p-4 w-96 shadow-xl')).toBe(1);
    expect(flagged('absolute right-0 mt-1 w-72 rounded-lg')).toBe(1);
    expect(flagged('absolute right-0 top-full w-64 max-h-80 overflow-y-auto')).toBe(1);
    // A max-height is not a width clamp.
    expect(flagged('absolute w-96 max-h-dvh-cap [--dvh-cap:80dvh]')).toBe(1);
    // The clamp, in either of the tree's two forms.
    expect(flagged('absolute right-3 w-96 max-w-[calc(100vw-1rem)] p-4')).toBe(0);
    expect(flagged('absolute w-80 max-w-[90vw] p-3')).toBe(0);
    // `min-w-*` is not a fixed width, at any variant prefix.
    expect(flagged('absolute bottom-3 left-3 right-3 sm:right-auto sm:min-w-80')).toBe(0);
    expect(flagged('absolute min-w-96 w-full')).toBe(0);
    // Narrow panels fit a 360px phone unclamped.
    expect(flagged('absolute right-0 w-56 rounded-lg')).toBe(0);
    // `fixed` escapes the shell's overflow box; it is positioned to the viewport.
    expect(flagged('fixed bottom-4 right-4 w-96 rounded-lg')).toBe(0);
    // A doc comment quoting an example class string is not markup.
    expect(violationsIn('// e.g. "absolute right-0 w-96"', 'probe.jsx')).toEqual([]);
  });

  it('never fixes a popover wider than a phone without a max-width', () => {
    expect(files.flatMap((file) => findViolations(file))).toEqual([]);
  });
});

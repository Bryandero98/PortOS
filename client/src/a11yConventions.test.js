/**
 * Repo-wide accessibility conventions.
 *
 * These encode the two regressions that keep reappearing across a11y audit
 * passes, so a new component fails the suite instead of shipping the gap:
 *
 *   1. A hand-rolled `fixed inset-0 … bg-black/N` overlay instead of the shared
 *      `ui/Modal`, which owns the focus trap, the Esc stack, `role="dialog"`,
 *      and focus restore. A hand-rolled backdrop is click-to-dismiss only — a
 *      keyboard user has no way out and tabs straight through to the page
 *      behind it.
 *   2. A toggle-switch-shaped `<button>` (a pill track with a sliding knob)
 *      that never says it is a switch, so assistive tech announces "button"
 *      with no on/off state. `components/ToggleSwitch.jsx` is the shared
 *      widget; hand-rolled tracks must at least carry `role="switch"` +
 *      `aria-checked`.
 *   3. A `<input type="file">` hidden with `hidden`/`aria-hidden`/`tabIndex={-1}`
 *      and driven by a programmatic `ref.current.click()`. That is unreachable
 *      by keyboard and screen reader, and the synthetic click doesn't open the
 *      picker at all in WebKit-as-installed-PWA — the shape PortOS is opened in
 *      from a second machine over the tailnet. `components/ui/FilePickerButton.jsx`
 *      is the shared widget (sr-only input + native `<label for>` activation).
 *   4. A `duration: Infinity` toast whose content is JSX or a render prop but
 *      which passes no `label`. Such a toast collapses to a pill after
 *      COLLAPSE_AFTER_MS (so it stops covering the page), and the pill has no
 *      text of its own to name itself with.
 *
 * Scoped to git-tracked `.jsx` under `client/src` so an untracked scratch file
 * can't fail the suite.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function trackedJsxFiles() {
  const out = execSync('git ls-files src', { cwd: CLIENT_ROOT, encoding: 'utf8' });
  return out.trim().split('\n').filter(f => f.endsWith('.jsx') && !f.includes('.test.'));
}

// Same, but including plain `.js` — hooks and services hold JSX and refs too
// (the OpenClaw composer's file-input ref lived in `hooks/useOpenClawAttachments.js`),
// so a rule that only scans `.jsx` has a hole exactly where a shared helper
// would reintroduce the pattern for many call sites at once.
function trackedSourceFiles() {
  const out = execSync('git ls-files src', { cwd: CLIENT_ROOT, encoding: 'utf8' });
  return out.trim().split('\n').filter(f => /\.jsx?$/.test(f) && !f.includes('.test.'));
}

/**
 * Slice out the full opening tag starting at `index`, tolerating `>` inside
 * JSX expression containers (`className={`a > b`}`) by tracking brace depth.
 */
function openingTagAt(src, index, nameLength) {
  let depth = 0;
  for (let i = index + nameLength; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(index, i + 1);
  }
  return null;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * Slice a call's full argument list, `(` through its matching `)`, starting at
 * the opening paren. Skips over string and template literals so a `)` inside
 * one can't close the call early.
 */
function balancedCallAt(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(openIndex, i + 1);
  }
  return null;
}

describe('a11y conventions', () => {
  // Modal.jsx IS the shared implementation; Drawer and Layout use the same
  // backdrop treatment for a slide-in panel / mobile nav scrim, both of which
  // already own Esc + focus handling of their own.
  // MediaLightbox documents its opt-out at the top of the file (viewport-edge
  // chevrons + a layered Esc cascade Modal's stack would swallow) and supplies
  // the dialog semantics itself: role="dialog"/aria-modal, useFocusTrap, and a
  // window-level Esc handler.
  const MODAL_BACKDROP_ALLOWLIST = new Set([
    'src/components/ui/Modal.jsx',
    'src/components/Drawer.jsx',
    'src/components/Layout.jsx',
    'src/components/media/MediaLightbox.jsx',
  ]);

  it('routes full-screen dark overlays through the shared <Modal>', () => {
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      if (MODAL_BACKDROP_ALLOWLIST.has(file)) continue;
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      // Only a dimming backdrop counts — `fixed inset-0` alone is also used for
      // non-modal chrome (HUD panels, drag overlays, canvas layers).
      const re = /fixed inset-0[^"'`]*bg-black\//g;
      let m;
      while ((m = re.exec(src))) {
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Hand-rolled modal backdrop — use components/ui/Modal.jsx (focus trap + Esc stack + role=dialog):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('marks toggle-switch buttons with role="switch"', () => {
    // Pill-track dimensions used by the hand-rolled toggles in this codebase.
    // A switch is always a fixed-size rounded-full track roughly twice as wide
    // as it is tall; ordinary rounded-full buttons (icon buttons, chips) don't
    // pin both dimensions like this.
    const TRACK_SIZES = /\b(h-6 w-11|w-11 h-6|w-10 h-5|h-5 w-10|h-5 w-9|w-9 h-5|h-8 w-14|w-14 h-8|h-7 w-12|w-12 h-7)\b/;
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag) continue;
        if (!/rounded-full/.test(tag) || !TRACK_SIZES.test(tag)) continue;
        if (/role="switch"/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Toggle-switch button without role="switch" + aria-checked — prefer components/ToggleSwitch.jsx:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps every file input focusable and label-activated', () => {
    // Two failures ride on the same markup, and neither reproduces for the
    // author: `display:none` (Tailwind `hidden`) drops the input from the tab
    // order AND the a11y tree, and a `<button onClick={ref.current.click()}>`
    // paired with it is a synthetic click several engines refuse to honor —
    // notably WebKit with PortOS installed as a standalone PWA, which is how it
    // gets opened from a second machine over the tailnet. The picker simply
    // never appears. components/ui/FilePickerButton.jsx is the shared fix
    // (sr-only input + a real <label for>); this test is what stops the old
    // idiom from creeping back in one component at a time.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<input\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<input'.length);
        // Match against the whole opening tag, not a quoted-attribute-shaped
        // regex: `type='file'` / `type={'file'}` and a `hidden` arriving via a
        // template literal or ternary (`className={cond ? 'hidden' : ''}`) are
        // the same bug, and a quote-specific pattern waves them through.
        if (!tag || !/\btype\s*=\s*[{'"]*\s*['"]?file\b/.test(tag)) continue;
        const hidden = /\bhidden\b/.test(tag) || /display:\s*['"]?none/.test(tag);
        const ariaHidden = /aria-hidden/.test(tag);
        const untabbable = /tabIndex\s*=\s*\{\s*-1\s*\}/.test(tag);
        if (!hidden && !ariaHidden && !untabbable) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `File input hidden from keyboard/AT — use components/ui/FilePickerButton.jsx (sr-only input + native <label for> activation), never className="hidden" / aria-hidden / tabIndex={-1} / display:none:\n${offenders.join('\n')}`).toEqual([]);
  });

  // A programmatic ref click is legitimate for a synthesized <a download> — the
  // rule below is about file inputs, so real non-input uses get an escape hatch
  // (mirroring MODAL_BACKDROP_ALLOWLIST) rather than a misleading failure.
  const REF_CLICK_ALLOWLIST = new Set([]);

  it('never opens a file picker with a programmatic ref click', () => {
    // The other half of the same bug: even a correctly-focusable input is
    // unopenable in those engines if a button reaches over and clicks it.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      if (REF_CLICK_ALLOWLIST.has(file)) continue;
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /\.current\s*\??\.\s*click\(\)/g;
      let m;
      while ((m = re.exec(src))) {
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `Programmatic .click() on a ref — if it targets a file input the picker never opens in WebKit/PWA; use components/ui/FilePickerButton.jsx. If the ref is genuinely NOT a file input (e.g. a synthesized <a download>), add the file to REF_CLICK_ALLOWLIST above with a comment:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('names every never-dismissing toast that cannot name itself', () => {
    // A `duration: Infinity` toast folds into an icon-only pill after
    // COLLAPSE_AFTER_MS so it stops covering the page (components/ui/Toast.jsx).
    // The pill takes its accessible name from string content — but JSX and
    // render-prop content have no text to take, so without `label` the whole
    // name is "Show notification" and the notice becomes unidentifiable to a
    // screen reader for the rest of its (unbounded) life. Nothing at runtime
    // complains, so this is the only thing that catches it.
    const offenders = [];
    for (const file of trackedSourceFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /\btoast(?:\.\w+)?\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        const call = balancedCallAt(src, re.lastIndex - 1);
        if (!call || !/\bduration:\s*Infinity\b/.test(call)) continue;
        // Only content that demonstrably isn't a string needs `label`: inline
        // JSX and render props. A literal or a variable is left alone — the
        // pill reads a string straight off `t.content`.
        const firstArg = call.slice(1).trimStart();
        const isJsx = firstArg.startsWith('<');
        const isRenderProp = /^(\([^)]*\)|\w+)\s*=>/.test(firstArg);
        if (!isJsx && !isRenderProp) continue;
        if (/\blabel:/.test(call)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `A duration: Infinity toast with JSX/render-prop content must pass \`label\` — it collapses to a pill that has no other accessible name (see COLLAPSE_AFTER_MS in components/ui/Toast.jsx):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('gives every role="switch" an aria-checked state', () => {
    const offenders = [];
    for (const file of trackedJsxFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      const re = /<button\b/g;
      let m;
      while ((m = re.exec(src))) {
        const tag = openingTagAt(src, m.index, '<button'.length);
        if (!tag || !/role="switch"/.test(tag)) continue;
        if (/aria-checked/.test(tag)) continue;
        offenders.push(`${file}:${lineOf(src, m.index)}`);
      }
    }
    expect(offenders, `role="switch" without aria-checked:\n${offenders.join('\n')}`).toEqual([]);
  });
});

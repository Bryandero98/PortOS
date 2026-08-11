/**
 * App-shell (`client/index.html`) boot guards.
 *
 * PortOS installs run on a private Tailscale network and are expected to work
 * with no route to the public internet — that is the premise of the offline
 * app-shell service worker in `public/sw.js`. A render-blocking stylesheet
 * pointed at a THIRD-PARTY host breaks that premise outright: when the host is
 * unreachable (no WAN, DNS sinkhole, outbound firewall) the browser holds the
 * first paint until the request times out, so the app is a blank white page for
 * ~60s on every load — with or without the service worker, because the SW's own
 * `fetch` for the stylesheet hangs the same way.
 *
 * The webfonts are a progressive enhancement: only the `lumen-glass-day` theme
 * puts Inter / IBM Plex Mono at the front of its stack, and every stack in
 * `themes/portosThemes.js` falls back to system fonts. So they must load
 * non-blocking (`media="print"` + `onload="this.media='all'"`), never as a boot
 * dependency.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(CLIENT_ROOT, 'index.html'), 'utf8');

// Every <link> tag in the shell, as whole tags (attributes may span lines).
const linkTags = html.match(/<link\b[^>]*>/gs) || [];

// `<noscript>` content is inert while JS is enabled, so a blocking stylesheet
// in there can't stall the app's boot. With JS off the SPA can't render at all,
// which makes it moot — so the render-blocking guard scans the shell WITHOUT
// noscript blocks, or it would flag its own graceful-degradation fallback.
const htmlWithoutNoscript = html.replace(/<noscript>.*?<\/noscript>/gs, '');
const activeLinkTags = htmlWithoutNoscript.match(/<link\b[^>]*>/gs) || [];

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 's'));
  return m ? m[1] : null;
};

const isStylesheet = (tag) => attr(tag, 'rel') === 'stylesheet';
const isCrossOrigin = (tag) => /^https?:\/\//.test(attr(tag, 'href') || '');

// A stylesheet only blocks the first paint when its media query matches the
// screen. `media="print"` (flipped to `all` by onload) downloads without
// blocking — the standard non-blocking-CSS pattern.
const isRenderBlocking = (tag) => {
  const media = attr(tag, 'media');
  return media === null || media === 'all' || media === 'screen';
};

describe('client/index.html — boot must not depend on a third-party host', () => {
  it('has no render-blocking cross-origin stylesheet', () => {
    const offenders = activeLinkTags
      .filter((t) => isStylesheet(t) && isCrossOrigin(t) && isRenderBlocking(t))
      .map((t) => attr(t, 'href'));

    expect(offenders).toEqual([]);
  });

  it('loads the Google Fonts stylesheet non-blocking and applies it on load', () => {
    const fontTag = activeLinkTags.find(
      (t) => isStylesheet(t) && (attr(t, 'href') || '').includes('fonts.googleapis.com')
    );
    // The webfonts are optional — if a future change drops them entirely, the
    // guard above still holds and there is nothing left to assert here.
    if (!fontTag) return;

    expect(attr(fontTag, 'media')).toBe('print');
    expect(attr(fontTag, 'onload')).toMatch(/this\.media\s*=\s*'all'/);
  });

  it('keeps a <noscript> fallback so the webfonts still apply without JS', () => {
    const noscript = html.match(/<noscript>(.*?)<\/noscript>/s)?.[1] || '';
    const hasFontLink = /<link\b[^>]*fonts\.googleapis\.com/s.test(noscript);
    const shellHasFonts = html.includes('fonts.googleapis.com/css2');

    expect(hasFontLink).toBe(shellHasFonts);
  });
});

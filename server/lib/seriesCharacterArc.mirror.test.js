/**
 * Parity guard: the character-arc editor's client-side input caps must match
 * the server's CHARACTER_ARC_LIMITS.
 *
 * `PipelineSeries.jsx` hard-codes an `ARC_LIMITS` object it feeds to the arc
 * inputs' `maxLength` / `max`. It can't import the server constant (browser
 * bundle), so the two are mirrored — and a mirror that drifts is worse than no
 * mirror here, because of how the write path fails: `updateSeries` replaces
 * `characterArcs` wholesale, so Save re-sends the entire arc list every time. A
 * single field over its Zod cap rejects the WHOLE series PATCH — name, logline,
 * premise, style guide and all — so a client cap that is larger than the
 * server's lets the user type a value that silently bricks every subsequent
 * save of the page.
 *
 * Reads the client file as TEXT rather than importing it: this suite runs in
 * the server (node) project, which has no React/lucide-react resolution.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CHARACTER_ARC_LIMITS } from './seriesCharacterArc.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_PAGE = join(REPO_ROOT, 'client', 'src', 'pages', 'PipelineSeries.jsx');

// The keys the editor actually renders an input for. A server limit with no
// input (e.g. TRANSITIONS_PER_ARC_MAX, enforced by the sanitizer dropping
// extras) is deliberately absent from the client mirror.
const MIRRORED_KEYS = [
  'CHARACTER_NAME_MAX',
  'WANT_MAX',
  'NEED_MAX',
  'START_STATE_MAX',
  'END_STATE_MAX',
  'TRANSITION_LABEL_MAX',
  'ISSUE_MAX',
];

function clientArcLimits() {
  const src = readFileSync(CLIENT_PAGE, 'utf8');
  const block = src.match(/const ARC_LIMITS = \{([\s\S]*?)\};/);
  if (!block) return null;
  const out = {};
  for (const [, key, value] of block[1].matchAll(/(\w+):\s*(\d+)\s*,/g)) {
    out[key] = Number(value);
  }
  return out;
}

describe('PipelineSeries ARC_LIMITS ↔ server CHARACTER_ARC_LIMITS', () => {
  it('declares an ARC_LIMITS mirror in the client page', () => {
    expect(clientArcLimits()).not.toBeNull();
  });

  it('mirrors every cap the arc editor renders an input for', () => {
    const client = clientArcLimits();
    expect(Object.keys(client).sort()).toEqual([...MIRRORED_KEYS].sort());
  });

  it.each(MIRRORED_KEYS)('%s matches the server cap', (key) => {
    expect(clientArcLimits()[key]).toBe(CHARACTER_ARC_LIMITS[key]);
  });

  it('caps every arc input the editor renders', () => {
    const src = readFileSync(CLIENT_PAGE, 'utf8');
    // Each arc field's input must carry a maxLength (or max, for atIssue) drawn
    // from the mirror — not a bare uncapped input.
    for (const key of MIRRORED_KEYS) {
      expect(src).toContain(`ARC_LIMITS.${key}`);
    }
  });
});

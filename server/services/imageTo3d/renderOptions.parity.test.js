/**
 * Cross-package parity for the image-to-3D render-option bounds.
 *
 * `renderOptions.js` owns the server-side bounds; `client/src/lib/
 * imageTo3dRenderOptions.js` is the hand-maintained client mirror (the input's
 * `max` attribute and the steps presets). This suite imports BOTH and asserts
 * they stay compatible — the same mechanism as
 * `unavailableReasons.parity.test.js` next door. It lives server-side because
 * the client mirror is a pure module that loads fine under the node runner.
 */

import { describe, it, expect } from 'vitest';
import {
  ALPHA_MODES,
  DETAIL_TIERS,
  RENDER_SEED_MAX,
  isValidRenderSteps,
} from './renderOptions.js';
import {
  ALPHA_MODE_PRESETS as CLIENT_ALPHA_MODE_PRESETS,
  DETAIL_PRESETS as CLIENT_DETAIL_PRESETS,
  SEED_MAX as CLIENT_SEED_MAX,
  STEPS_PRESETS as CLIENT_STEPS_PRESETS,
} from '../../../client/src/lib/imageTo3dRenderOptions.js';

describe('image-to-3D render-option parity (server bounds ↔ client mirror)', () => {
  it('the client seed ceiling equals the server bound', () => {
    expect(CLIENT_SEED_MAX).toBe(RENDER_SEED_MAX);
  });

  it('the client detail presets cover exactly the server tiers', () => {
    // Both directions matter: a client tier the server rejects 400s the render, and
    // a server tier with no client preset is a knob the user can never reach.
    expect(CLIENT_DETAIL_PRESETS.map((p) => p.value).sort()).toEqual([...DETAIL_TIERS].sort());
  });

  it('every client alpha-mode preset is a server mode, plus the unset sentinel', () => {
    const values = CLIENT_ALPHA_MODE_PRESETS.map((p) => p.value);
    // '' is client-only and load-bearing: it means "leave PortOS's force-opaque
    // normalization on", which is distinct from asking the exporter for OPAQUE.
    expect(values).toContain('');
    expect(values.filter((v) => v !== '').sort()).toEqual([...ALPHA_MODES].sort());
  });

  it('every non-default client steps preset is a value the server accepts', () => {
    const numeric = CLIENT_STEPS_PRESETS
      .map((preset) => preset.value)
      .filter((value) => value !== '');
    expect(numeric.length).toBeGreaterThan(0);
    for (const value of numeric) {
      expect(isValidRenderSteps(Number(value)), `preset ${value}`).toBe(true);
    }
  });
});

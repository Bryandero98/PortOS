import { describe, expect, it } from 'vitest';
import {
  missingModulesLabel,
  appendMissingModules,
  describeDegradedInstall,
} from './degradedInstall.js';

// Both image-to-3D install lanes report "these compiled modules did not build" — the MPS
// texture-bake backends and the Pixal3D CUDA extensions — so one builder owns the split
// between the remedy and the culprits, and neither lane re-assembles it (#4741).
describe('missingModulesLabel', () => {
  it('names every module, comma-separated and punctuation-free', () => {
    // Punctuation-free on purpose: this is `degraded.detail`, a standalone card line.
    expect(missingModulesLabel(['o_voxel', 'flex_gemm'])).toBe('Missing: o_voxel, flex_gemm');
  });

  it('yields nothing to render for an empty or absent list', () => {
    // A bare "Missing:" would read as a determined verdict with the culprit lost.
    expect(missingModulesLabel([])).toBe('');
    expect(missingModulesLabel(undefined)).toBe('');
  });
});

describe('appendMissingModules', () => {
  it('closes the remedy prose with the module sentence', () => {
    expect(appendMissingModules('Repair install rebuilds them.', ['o_voxel']))
      .toBe('Repair install rebuilds them. Missing: o_voxel.');
  });

  it('returns the prose untouched when there is nothing to name', () => {
    // A degradation with no module list must not gain a dangling sentence.
    expect(appendMissingModules('NATTEN is missing.', [])).toBe('NATTEN is missing.');
    expect(appendMissingModules('NATTEN is missing.', undefined)).toBe('NATTEN is missing.');
  });
});

describe('describeDegradedInstall', () => {
  it('splits the remedy from the culprits for the card, and rejoins them for the prose frame', () => {
    // The card has a second line for `detail`; the `verify` stage has one string, so the
    // same condition has to survive both without being worded twice.
    const { degraded, warnings } = describeDegradedInstall({
      label: 'incomplete install', help: 'Repair install rebuilds them.', missing: ['o_voxel'],
    });
    expect(degraded).toEqual({
      label: 'incomplete install',
      help: 'Repair install rebuilds them.',
      repairable: true,
      detail: 'Missing: o_voxel',
    });
    expect(warnings).toEqual(['Repair install rebuilds them. Missing: o_voxel.']);
  });

  it('omits detail entirely when the probe has nothing to name', () => {
    // Omitting beats an empty string: the client renders `detail` whenever it is present.
    const { degraded } = describeDegradedInstall({ label: 'NAF fallback', help: 'Repair it.' });
    expect(degraded).toEqual({ label: 'NAF fallback', help: 'Repair it.', repairable: true });
    expect(degraded).not.toHaveProperty('detail');
  });

  it('carries an unrepairable degradation through rather than defaulting it away', () => {
    // `repairable: false` is what hides the Repair button; defaulting it to true would
    // offer an action that cannot work.
    const { degraded } = describeDegradedInstall({
      label: 'degraded textures', help: 'Install Xcode.', repairable: false, missing: ['o_voxel'],
    });
    expect(degraded.repairable).toBe(false);
  });

  it('warns about nothing when the degradation produced no prose', () => {
    // A `[undefined]` frame would render as the literal string "undefined" in the log.
    expect(describeDegradedInstall({ label: 'NAF fallback', help: undefined }).warnings).toEqual([]);
  });
});

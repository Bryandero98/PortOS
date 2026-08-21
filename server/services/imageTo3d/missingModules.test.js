import { describe, expect, it } from 'vitest';
import { missingModulesLabel, appendMissingModules } from './missingModules.js';

// Both image-to-3D install lanes report "these compiled modules did not build" — the MPS
// texture-bake backends and the Pixal3D CUDA extensions — so one wording lives here and
// neither lane re-assembles it (#4741).
describe('missingModulesLabel', () => {
  it('names every module, comma-separated and punctuation-free', () => {
    // Punctuation-free on purpose: this is `degraded.detail`, a standalone card line.
    expect(missingModulesLabel(['o_voxel', 'flex_gemm'])).toBe('Missing: o_voxel, flex_gemm');
  });

  it('yields nothing to render for an empty or absent list', () => {
    // A bare "Missing:" would read as a determined verdict with the culprit lost.
    expect(missingModulesLabel([])).toBe('');
    expect(missingModulesLabel(undefined)).toBe('');
    expect(missingModulesLabel(null)).toBe('');
  });
});

describe('appendMissingModules', () => {
  it('closes the remedy prose with the module sentence', () => {
    expect(appendMissingModules('Repair install rebuilds them.', ['o_voxel']))
      .toBe('Repair install rebuilds them. Missing: o_voxel.');
  });

  it('returns the prose untouched when there is nothing to name', () => {
    // The NAF-fallback lane has no module list; it must not gain a dangling sentence.
    expect(appendMissingModules('NATTEN is missing.', [])).toBe('NATTEN is missing.');
    expect(appendMissingModules('NATTEN is missing.', undefined)).toBe('NATTEN is missing.');
  });
});

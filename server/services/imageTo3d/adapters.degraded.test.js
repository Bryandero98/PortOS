import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the module probe is stubbed — the projection under test is the real thing.
vi.mock('./pixal3dCuda.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probePixal3dModules: vi.fn(),
}));

// Same treatment for the MPS lane: the probes are stubbed, the projection is real —
// including the missing-module formatter it shares with the install's verify frame.
vi.mock('./trellis2.js', async (importOriginal) => ({
  ...(await importOriginal()),
  probeTrellis2TextureBake: vi.fn(),
  probeMetalToolchain: vi.fn(),
}));

import { TARGET_ADAPTERS } from './adapters.js';
import { probePixal3dModules, PIXAL3D_NAF_FALLBACK_HELP } from './pixal3dCuda.js';
import { probeTrellis2TextureBake, probeMetalToolchain } from './trellis2.js';

const describeState = () => TARGET_ADAPTERS.pixal3dCuda.describeInstallState();

describe('pixal3dCuda degraded-state projection', () => {
  it('reports an incomplete install when a REQUIRED extension did not build', async () => {
    // `setup.sh` is sourced and can exit 0 with a failed extension build, and the
    // install's `verify` hook only checks the interpreter + entrypoint. So this
    // projection is the ONLY thing standing between a half-built install and a card
    // that reads plain "Ready" until the first render dies in the GLB exporter.
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: ['o_voxel'] });
    const state = await describeState();
    expect(state.fields.degraded).toMatchObject({ label: 'incomplete install', repairable: true });
    expect(state.fields.degraded.help).toContain('o_voxel');
    expect(state.warnings).toHaveLength(1);
  });

  it('names every missing extension, not just the first', async () => {
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: ['o_voxel', 'flex_gemm'] });
    const state = await describeState();
    expect(state.fields.degraded.help).toContain('o_voxel and flex_gemm');
  });

  it('lets an incomplete install outrank a NAF fallback', async () => {
    // Both are repairable by the same action, so reporting the milder one would
    // understate the problem.
    probePixal3dModules.mockResolvedValueOnce({
      naf: 'unavailable', missing: ['o_voxel'], help: PIXAL3D_NAF_FALLBACK_HELP,
    });
    const state = await describeState();
    expect(state.fields.degraded.label).toBe('incomplete install');
  });

  it('reports the NAF fallback when the install is otherwise complete', async () => {
    probePixal3dModules.mockResolvedValueOnce({
      naf: 'unavailable', missing: [], help: PIXAL3D_NAF_FALLBACK_HELP,
    });
    const state = await describeState();
    expect(state.fields.degraded).toEqual({
      label: 'NAF fallback', help: PIXAL3D_NAF_FALLBACK_HELP, repairable: true,
    });
  });

  it('reports nothing degraded for a healthy install', async () => {
    probePixal3dModules.mockResolvedValueOnce({ naf: 'available', missing: [] });
    const state = await describeState();
    expect(state.fields.degraded).toBeUndefined();
    expect(state.warnings).toEqual([]);
    expect(state.fields.naf).toBe('available');
  });

  it('reports nothing degraded when the probe could not run', async () => {
    // "Failed to determine" must never render as "determined to be broken".
    probePixal3dModules.mockResolvedValueOnce({ naf: 'unknown', missing: [] });
    const state = await describeState();
    expect(state.fields.degraded).toBeUndefined();
    expect(state.warnings).toEqual([]);
  });
});

// #4636: the card told the user which remedy to run but never what was missing, so a
// Repair that kept failing reprinted one generic sentence forever. `detail` carries
// the culprit modules through the SAME normalized `degraded` shape the client already
// renders — no per-target UI branch, and no reader on the back-compat `textureBake`.
describe('trellis2 degraded-state projection', () => {
  const describeTrellis2 = () => TARGET_ADAPTERS.trellis2.describeInstallState();
  const fallback = (missing) => ({
    quality: 'fallback', missing, degradedQuality: [], modules: {}, help: 'fix it',
  });

  // The toolchain probe is only consulted for a DEGRADED bake, and one case asserts it
  // was never reached — so its call log has to start empty in every test.
  beforeEach(() => {
    probeTrellis2TextureBake.mockClear();
    probeMetalToolchain.mockClear();
  });

  it('names the missing bake modules in degraded.detail', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce(fallback(['o_voxel', 'mtlbvh']));
    probeMetalToolchain.mockResolvedValueOnce({ available: false, installable: true });
    const state = await describeTrellis2();
    expect(state.fields.degraded).toEqual({
      label: 'degraded textures', help: 'fix it', repairable: true, detail: 'Missing: o_voxel, mtlbvh',
    });
    // Finding 1: the install route replays `warnings` into the SAME `verify` stage the
    // install's own hook writes, so it has to name the modules too — otherwise one
    // condition emits two different frames depending on the path taken.
    expect(state.warnings).toEqual(['fix it Missing: o_voxel, mtlbvh.']);
  });

  // On a Command-Line-Tools-only host `help` becomes the Xcode hint, but WHICH modules
  // failed is still the useful half of the report.
  it('keeps the detail on the non-repairable toolchain-blocker path', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce(fallback(['o_voxel']));
    probeMetalToolchain.mockResolvedValueOnce({
      available: false, installable: false, blocker: 'requires-xcode', hint: 'install Xcode',
    });
    const state = await describeTrellis2();
    expect(state.fields.degraded).toEqual({
      label: 'degraded textures', help: 'install Xcode', repairable: false, detail: 'Missing: o_voxel',
    });
    // The route replays `warnings` into the SAME `verify` stage the install writes,
    // and that hook now resolves the remedy through the same helper — so a blocker
    // host is told to install Xcode on BOTH paths, never to run the Repair the card
    // has already hidden (#4742). The literal is asserted verbatim in trellis2.test.js
    // against the install's own frame.
    expect(state.warnings).toEqual(['install Xcode Missing: o_voxel.']);
  });

  it('reports nothing degraded — and no detail — for a healthy Metal bake', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'metal', missing: [], degradedQuality: [], modules: {},
    });
    const state = await describeTrellis2();
    expect(state.fields.degraded).toBeUndefined();
    expect(state.warnings).toEqual([]);
  });

  // A probe that could not run must not render a module list (could-not-determine ≠
  // determined-to-be-bad).
  it('reports nothing when the bake probe could not run', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'unknown', missing: [], degradedQuality: [], modules: {},
    });
    const state = await describeTrellis2();
    expect(state.fields.degraded).toBeUndefined();
    expect(probeMetalToolchain).not.toHaveBeenCalled();
  });

  // `flex_gemm` degrades bake QUALITY without forcing the fallback baker, so it must
  // never be listed as a cause of the scrambled surface.
  it('does not list degradedQuality modules as missing', async () => {
    probeTrellis2TextureBake.mockResolvedValueOnce({
      quality: 'fallback', missing: ['o_voxel'], degradedQuality: ['flex_gemm'], modules: {}, help: 'fix it',
    });
    probeMetalToolchain.mockResolvedValueOnce({ available: false, installable: true });
    const state = await describeTrellis2();
    expect(state.fields.degraded.detail).toBe('Missing: o_voxel');
  });
});

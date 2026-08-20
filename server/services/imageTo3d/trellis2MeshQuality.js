/**
 * TRELLIS.2 (Apple Silicon / MPS) — mesh-quality knobs the upstream port hardcodes.
 *
 * Split out of `trellis2.js` rather than appended to it: that module is already
 * ~850 lines covering install/probe/progress/run, and these are a self-contained
 * set of pure selectors plus one install step. Everything here is pure except
 * `trellis2FillHolesStep`, which is a plain data descriptor (not a spawn).
 *
 * ## Why a decimation target exists at all
 *
 * `generate.py` clamps its bake mesh to `min(200000, faces)` before handing it to
 * the Metal BVH. That constant was tuned for the **512** pipeline (~800K decoded
 * faces, a sane 4x reduction). On `1024_cascade` the decoder emits ~22.7M faces —
 * measured, not estimated, on the reference M5 Max install — so the same constant
 * becomes a **115x** reduction that throws away 99.1% of the geometry the render
 * just spent 13–20 minutes producing. Meanwhile `o_voxel.postprocess.to_glb`
 * defaults its own `decimation_target` to 1,000,000: the baker is built for 5x
 * more than upstream ever hands it.
 *
 * Upstream's stated reason — "the BVH builder is unstable on 800K+ face inputs" —
 * was a 24-slot traversal stack in mtlbvh that silently dropped subtrees. Fixed in
 * mtlbvh `bc0a534` (stack 24→64), which post-dates trellis-mac's last commit
 * (2026-04-28, dormant since). So the clamp guards a bug that is no longer in the
 * dependency set PortOS installs.
 *
 * ## Why these numbers
 *
 * The targets below are deliberately conservative against the *evidence*, not
 * against the theoretical ceiling:
 *  - mtlbvh's own regression test covers 498K triangles; its fix commit reports a
 *    clean result on an 8.6M-face mesh.
 *  - trellis-mac#11 exercises decode-time cumesh on a 2.99M-face mesh.
 *  - upstream PR #175 reports a 3.09M-triangle export with no decimation at all.
 *  - `to_glb`'s own default is 1,000,000.
 *
 * 1,000,000 therefore sits at the exporter's own default and below every reported
 * working size, while still being **5x** upstream's clamp. It is not the largest
 * defensible number; it is the largest one that does not outrun published results.
 * The browser is the other constraint: the reference 197K-face GLB is 58 MB with
 * two 4096² atlases, so geometry at 1M faces lands the viewer around ~105 MB.
 * Going further belongs in a separate high-detail export, not in the file the 3D
 * page loads.
 */

import { fileURLToPath } from 'node:url';

/** The constant `generate.py` clamps to, and the runner asserts against. */
export const TRELLIS2_DECIMATION_UPSTREAM_CLAMP = 200000;

/**
 * Baseline tier — the supported 24 GB floor. Kept well under the high tier
 * because those hosts also run the `512` pipeline, whose decoded mesh is ~800K
 * faces: a 500K target is a real gain over 200K without pretending a 24 GB Mac
 * should carry a million-face viewer payload.
 */
export const TRELLIS2_DECIMATION_BASELINE = 500000;

/** High-memory tier — `to_glb`'s own default (see the file header). */
export const TRELLIS2_DECIMATION_HIGH = 1000000;

/**
 * Accepted range for an explicit per-run override. The floor is 1 (a caller may
 * legitimately want a tiny proxy mesh); the ceiling is the largest face count with
 * any published Apple-Silicon result behind it (mtlbvh's fix commit, 8.6M).
 * Deliberately NOT unbounded — a mistyped value here costs a whole render.
 */
export const TRELLIS2_DECIMATION_MIN = 1;
export const TRELLIS2_DECIMATION_MAX = 8600000;

/**
 * Pick the viewer-GLB decimation target from physical unified memory.
 *
 * Keyed on the SAME `TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB` threshold the pipeline
 * and texture-size selectors use, and takes it as an argument rather than importing
 * it — that keeps this module free of a cycle back into `trellis2.js` while making
 * the shared threshold explicit at the call site.
 *
 * @param {number} unifiedMemoryGb
 * @param {number} highTierMinGb the shared high-tier memory threshold
 * @returns {number}
 */
export function selectTrellis2DecimationTarget(unifiedMemoryGb, highTierMinGb) {
  return Number(unifiedMemoryGb) >= highTierMinGb
    ? TRELLIS2_DECIMATION_HIGH
    : TRELLIS2_DECIMATION_BASELINE;
}

/** Whether a value is a usable explicit decimation target (null/undefined = unset). */
export const isValidDecimationTarget = (value) => (
  Number.isInteger(value)
  && value >= TRELLIS2_DECIMATION_MIN
  && value <= TRELLIS2_DECIMATION_MAX
);

/**
 * Accepted glTF alpha modes, mirroring `o_voxel.postprocess.to_glb`.
 *
 * `'auto'` is the exporter's own opt-in heuristic: BLEND only when more than
 * `alpha_blend_min_fraction` (1%) of valid texels fall below
 * `alpha_blend_threshold` (0.5). That 1% floor is what makes it safe now and is
 * precisely what was missing from the older exporter behaviour PortOS's
 * `forceOpaqueGlbMaterials` was written to defend against — see the note in
 * `glbMaterials.js`.
 */
export const TRELLIS2_ALPHA_MODES = ['OPAQUE', 'auto', 'BLEND', 'MASK'];

/**
 * Cap on the source mesh the normal-map bake samples from.
 *
 * The bake builds a BVH over the pre-decimation mesh, and at `1024_cascade` that is
 * ~22.7M faces — beyond any published Apple-Silicon result (mtlbvh's fix commit
 * reports a clean run at 8.6M; its regression test covers 498K). Above this the
 * source is decimated to the cap for the bake ONLY, which still leaves ~8x the
 * geometry of the exported mesh, so nearly all the recoverable relief survives.
 *
 * A documented ceiling rather than an attempt to find the real limit at the cost of
 * someone's render.
 */
export const TRELLIS2_NORMAL_SOURCE_FACE_CAP = 8000000;

/**
 * Emit the runner's PortOS-only flags, terminated by `--`.
 *
 * The separator is load-bearing: everything after it is handed to upstream's own
 * argparse, which would reject these flags as unknown. `null`/`false` omits a flag
 * so the exporter default applies — the same absent-vs-empty sentinel discipline
 * the per-run render options use.
 *
 * Throws rather than clamping on a bad `decimationTarget`: a silently clamped value
 * would make the run ledger record a target the subprocess never received.
 *
 * @param {{decimationTarget?: number|null, fillHoles?: boolean, remesh?: boolean,
 *          meshClusterRefineIterations?: number|null,
 *          meshClusterSmoothStrength?: number|null,
 *          alphaMode?: string|null, normalMap?: boolean,
 *          normalMapMaxSourceFaces?: number|null}} [opts]
 * @returns {string[]}
 */
export function trellis2MeshQualityArgs({
  decimationTarget = null,
  fillHoles = false,
  remesh = false,
  meshClusterRefineIterations = null,
  meshClusterSmoothStrength = null,
  alphaMode = null,
  normalMap = false,
  normalMapMaxSourceFaces = null,
} = {}) {
  if (decimationTarget !== null && !isValidDecimationTarget(decimationTarget)) {
    throw new Error(
      `trellis2MeshQualityArgs: decimationTarget must be an integer in `
      + `[${TRELLIS2_DECIMATION_MIN}, ${TRELLIS2_DECIMATION_MAX}]`,
    );
  }
  if (alphaMode !== null && !TRELLIS2_ALPHA_MODES.includes(alphaMode)) {
    throw new Error(
      `trellis2MeshQualityArgs: alphaMode must be one of ${TRELLIS2_ALPHA_MODES.join(', ')}`,
    );
  }
  return [
    ...(decimationTarget !== null ? ['--decimation-target', String(decimationTarget)] : []),
    ...(fillHoles ? ['--fill-holes'] : []),
    ...(remesh ? ['--remesh'] : []),
    ...(meshClusterRefineIterations !== null
      ? ['--mesh-cluster-refine-iterations', String(meshClusterRefineIterations)] : []),
    ...(meshClusterSmoothStrength !== null
      ? ['--mesh-cluster-smooth-strength', String(meshClusterSmoothStrength)] : []),
    ...(alphaMode !== null ? ['--alpha-mode', alphaMode] : []),
    ...(normalMap ? ['--normal-map'] : []),
    // Only meaningful alongside --normal-map; emitted independently so an explicit
    // cap is still recorded in the argv the run entry reflects.
    ...(normalMapMaxSourceFaces !== null
      ? ['--normal-map-max-source-faces', String(normalMapMaxSourceFaces)] : []),
    '--',
  ];
}

/**
 * Absolute path to the install-time patcher that converts upstream's hard
 * `fill_holes` stub into an environment check.
 * @returns {string}
 */
export function trellis2FillHolesScript() {
  return fileURLToPath(new URL('./trellis2RestoreFillHoles.py', import.meta.url));
}

/**
 * The install step that adds the `fill_holes` gate.
 *
 * Ordering is load-bearing and the reason this is a step rather than a runtime
 * patch: `setup.sh` runs `patches/mps_compat.py`, which is what *writes* the stub.
 * So this has to come AFTER setup, or it would assert on a file that has not been
 * stubbed yet and fail every fresh install.
 *
 * `optional: true` for the same reason the Metal-toolchain step is: a host where
 * the gate cannot be applied must still install and render. Hole filling is opt-in
 * anyway, so the degraded outcome is exactly today's behaviour — and asking for
 * `--fill-holes` on such a host errors loudly in the runner rather than silently
 * rendering without it.
 *
 * Runs under the venv's Python so it cannot depend on a system interpreter the
 * host may not have.
 *
 * @param {string} python the venv python path
 * @param {string} root the trellis2 clone root
 * @returns {{stage: string, command: string, args: string[], optional: boolean}}
 */
export function trellis2FillHolesStep(python, root) {
  return {
    stage: 'fill-holes-gate',
    command: python,
    args: [trellis2FillHolesScript(), root],
    optional: true,
  };
}

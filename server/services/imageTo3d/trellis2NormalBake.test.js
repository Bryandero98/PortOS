import { execFileSync } from '../../lib/childProcess.js';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTestPython } from '../../lib/testHelper.js';
import { trellis2VenvPython } from './trellis2.js';

// The bake's helpers are numpy-based, and the interpreter `resolveTestPython` finds is
// a bare system python3 that generally has no numpy. So probe for an interpreter that
// can actually import it, preferring the plain one and falling back to the TRELLIS.2
// venv (which necessarily has numpy) when this host has an install. Neither is a
// requirement: on a machine with neither, the suite skips rather than failing, the same
// posture as the other Python-driven suites here.
function resolveNumpyPython() {
  const candidates = [resolveTestPython(), trellis2VenvPython()].filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes('/') && !existsSync(bin)) continue;
    try {
      execFileSync(bin, ['-c', 'import numpy'], { stdio: 'ignore' });
      return bin;
    } catch {
      // Not this one — keep looking.
    }
  }
  return null;
}

const pyBin = resolveNumpyPython();
const MODULE_DIR = new URL('.', import.meta.url).pathname;

describe.skipIf(!pyBin)('trellis2NormalBake helpers', () => {
  const run = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-nbake-'));
    const script = join(dir, 'case.py');
    try {
      writeFileSync(script, [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(MODULE_DIR)})`,
        'import numpy as np',
        'import trellis2NormalBake as nb',
        body,
      ].join('\n'));
      return JSON.parse(execFileSync(pyBin, [script], { encoding: 'utf8' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  describe('decoder_to_export_space', () => {
    // The axis swap to_glb performs on its way out. Getting it wrong produced a
    // unit-length but essentially random normal map (measured: mean tangent-space z
    // of ~0.06 against a correct ~0.98), so it gets a direct test rather than only
    // being exercised through the GPU path.
    it('maps (x, y, z) to (x, z, -y), matching to_glb', () => {
      const r = run(`
pts = np.array([[1, 2, 3], [0, 1, 0], [-1, -2, -3]], dtype=np.float32)
print(json.dumps(nb.decoder_to_export_space(pts).tolist()))
`);
      expect(r).toEqual([[1, 3, -2], [0, 0, -1], [-1, -3, 2]]);
    });

    it('does not mutate its input', () => {
      // The source array is reused by the caller for the BVH; an in-place swap would
      // corrupt it. to_glb's own comment flags the same hazard ("must copy to avoid
      // in-place corruption").
      const r = run(`
pts = np.array([[1, 2, 3]], dtype=np.float32)
out = nb.decoder_to_export_space(pts)
print(json.dumps({"input": pts.tolist(), "output": out.tolist()}))
`);
      expect(r.input).toEqual([[1, 2, 3]]);
      expect(r.output).toEqual([[1, 3, -2]]);
    });

    it('is length-preserving, as a rotation must be', () => {
      const r = run(`
rng = np.random.default_rng(7)
pts = rng.normal(size=(500, 3)).astype(np.float32)
a = np.linalg.norm(pts, axis=-1)
b = np.linalg.norm(nb.decoder_to_export_space(pts), axis=-1)
print(json.dumps({"max_delta": float(np.abs(a - b).max())}))
`);
      expect(r.max_delta).toBeLessThan(1e-5);
    });
  });

  describe('compute_vertex_normals', () => {
    it('returns unit normals for a planar quad', () => {
      const r = run(`
v = np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0]], dtype=np.float32)
f = np.array([[0,1,2],[0,2,3]], dtype=np.int32)
n = nb.compute_vertex_normals(v, f)
print(json.dumps({"normals": n.tolist(), "lengths": np.linalg.norm(n, axis=-1).tolist()}))
`);
      for (const n of r.normals) expect(n).toEqual([0, 0, 1]);
      for (const l of r.lengths) expect(l).toBeCloseTo(1, 5);
    });

    it('weights by area, so slivers cannot outvote a large face', () => {
      // The decoder emits wildly uneven triangle areas; uniform averaging lets a
      // cluster of slivers dominate the face that actually describes the surface.
      const r = run(`
v = np.array([[0,0,0],[10,0,0],[0,10,0],[0,0,0.001]], dtype=np.float32)
f = np.array([[0,1,2],[0,1,3]], dtype=np.int32)
print(json.dumps({"z": float(abs(nb.compute_vertex_normals(v, f)[0][2]))}))
`);
      expect(r.z).toBeGreaterThan(0.99);
    });

    it('yields a finite zero vector for an unreferenced vertex', () => {
      // np.add.at leaves it at zero; normalizing must not divide by zero and produce
      // NaN, which would poison every texel that interpolates it.
      const r = run(`
v = np.array([[0,0,0],[1,0,0],[0,1,0],[5,5,5]], dtype=np.float32)
f = np.array([[0,1,2]], dtype=np.int32)
n = nb.compute_vertex_normals(v, f)
print(json.dumps({"finite": bool(np.all(np.isfinite(n))), "orphan": n[3].tolist()}))
`);
      expect(r.finite).toBe(true);
      expect(r.orphan).toEqual([0, 0, 0]);
    });
  });

  describe('compute_uv_tangents', () => {
    it('points along +X for an axis-aligned UV map', () => {
      const r = run(`
v = np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0]], dtype=np.float32)
f = np.array([[0,1,2],[0,2,3]], dtype=np.int32)
uv = np.array([[0,0],[1,0],[1,1],[0,1]], dtype=np.float32)
t, w = nb.compute_uv_tangents(v, f, uv)
t = nb._unit(t)
print(json.dumps({"first": t[0].tolist(), "w": w.tolist()}))
`);
      expect(r.first[0]).toBeCloseTo(1, 4);
      expect(Math.abs(r.first[1])).toBeLessThan(1e-4);
      expect(r.w.every((x) => x === 1)).toBe(true);
    });

    // The bug this pins was a real defect: `b = cross(n, t)` with no handedness term.
    // A UV unwrapper may mirror individual charts (cumesh's does), and on a mirrored
    // chart that bitangent is EXACTLY inverted — so the baked green channel flips and
    // bumps read as dents, with a discontinuity at every chart seam. No global sign
    // fixes it, because both handednesses coexist in one atlas. Verified by measuring
    // dot(B, V-increasing-direction): -1.00 before the fix, +1.00 after.
    it('derives bitangent handedness per chart, so a mirrored chart is not inverted', () => {
      const r = run(`
n = np.array([0.,0.,1.])
def probe(uv):
    v = np.array([[0,0,0],[1,0,0],[0,1,0]], dtype=np.float32)
    f = np.array([[0,1,2]], dtype=np.int32)
    t, w = nb.compute_uv_tangents(v, f, np.asarray(uv, np.float32))
    T = nb._unit(t)[0]
    # Ground truth: the 3D direction along which V increases.
    duv = np.asarray(uv, np.float32)
    g = np.linalg.lstsq((v[1:] - v[0])[:, :2], duv[1:,1] - duv[0,1], rcond=None)[0]
    truth = nb._unit(np.array([[g[0], g[1], 0.]]))[0]
    return {
        "w": float(w[0]),
        "naive": float(np.cross(n, T) @ truth),
        "corrected": float((np.cross(n, T) * w[0]) @ truth),
    }
print(json.dumps({
    "unmirrored": probe([[0,0],[1,0],[0,1]]),
    "mirrored":   probe([[0,1],[1,1],[0,0]]),
}))
`);
      // Unmirrored: both agree with the V direction.
      expect(r.unmirrored.w).toBe(1);
      expect(r.unmirrored.corrected).toBeCloseTo(1, 3);
      // Mirrored: the naive cross product is exactly backwards; ours is not.
      expect(r.mirrored.w).toBe(-1);
      expect(r.mirrored.naive).toBeCloseTo(-1, 3);
      expect(r.mirrored.corrected).toBeCloseTo(1, 3);
    });

    it('breaks a seam-vertex handedness tie deterministically instead of emitting 0', () => {
      // A vertex straddling two oppositely-wound charts sums to exactly 0. Returning 0
      // would zero the bitangent and collapse the frame.
      const r = run(`
v = np.array([[0,0,0],[1,0,0],[0,1,0],[-1,0,0]], dtype=np.float32)
f = np.array([[0,1,2],[0,2,3]], dtype=np.int32)
uv = np.array([[0,0],[1,0],[0,1],[0,-1]], dtype=np.float32)
t, w = nb.compute_uv_tangents(v, f, uv)
print(json.dumps({"w": w.tolist(), "any_zero": bool((w == 0).any())}))
`);
      expect(r.any_zero).toBe(false);
      for (const x of r.w) expect(Math.abs(x)).toBe(1);
    });

    it('survives a degenerate UV triangle without NaN', () => {
      // Zero-area-in-texture-space faces have no defined tangent. Left unguarded the
      // reciprocal explodes and poisons every vertex the face touches.
      const r = run(`
v = np.array([[0,0,0],[1,0,0],[1,1,0],[0,1,0]], dtype=np.float32)
f = np.array([[0,1,2],[0,2,3]], dtype=np.int32)
uv = np.zeros((4, 2), dtype=np.float32)
t, w = nb.compute_uv_tangents(v, f, uv)
print(json.dumps({"finite": bool(np.all(np.isfinite(t))) and bool(np.all(np.isfinite(w)))}))
`);
      expect(r.finite).toBe(true);
    });
  });

  describe('_extract_mesh', () => {
    it('rejects a mesh with no UVs rather than baking against nothing', () => {
      // A silent fallback here would attach a plausible-looking but meaningless map.
      const r = run(`
class V: uv = None
class M:
    visual = V()
try:
    nb._extract_mesh(M())
    print(json.dumps({"raised": None}))
except ValueError as e:
    print(json.dumps({"raised": str(e)}))
`);
      expect(r.raised).toMatch(/requires the exported mesh to carry UVs/);
    });

    it('refuses an ambiguous multi-mesh scene', () => {
      const r = run(`
class S: geometry = {"a": object(), "b": object()}
try:
    nb._extract_mesh(S())
    print(json.dumps({"raised": None}))
except ValueError as e:
    print(json.dumps({"raised": str(e)}))
`);
      expect(r.raised).toMatch(/expects exactly one mesh, got 2/);
    });
  });
});

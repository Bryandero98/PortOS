"""Bake a tangent-space normal map from the pre-decimation mesh onto the exported one.

## Why

Decimation is the largest single quality loss in the Apple Silicon path: the
`1024_cascade` decoder emits ~22.7M faces and the exported GLB carries ~1M. Raising
the target recovers silhouette and large-scale form, but a browser cannot be handed
22.7M faces, so the fine surface relief is gone for good — as *geometry*. As
*shading* it is recoverable, which is what a normal map is for: it re-encodes the
high-resolution surface orientation into a texture the low-resolution mesh samples,
so lighting responds to detail the triangles no longer carry.

The correspondence this needs is the same one the base-color bake already computes
(`o_voxel.postprocess.to_glb`: UV-rasterize the decimated mesh, interpolate a 3D
position per texel, then `bvh.unsigned_distance(..., return_uvw=True)` against the
source mesh). This module re-derives that correspondence as a post-pass rather than
patching into third-party internals, and pays one extra BVH build plus one extra UV
rasterization for it.

## Why a post-pass and not a hook

`to_glb` receives the mesh generate.py *already* pre-simplified, so its internal
"original" is the decimated mesh — there is no high-resolution surface left inside it
to sample from. The only place the full mesh exists is generate.py's scope, which the
runner captures at its `fast_simplification.simplify` interception point. So the bake
has to run outside `to_glb`, against that captured mesh.

## Source cap

A BVH over 22.7M faces is beyond any published Apple-Silicon result (mtlbvh's own fix
commit reports a clean run at 8.6M; its regression test covers 498K). So the source is
capped: above `max_source_faces` it is decimated to that ceiling *for the normal
source only*. At the default that is still ~8x the geometry of the exported mesh, so
nearly all the recoverable relief survives, while the BVH stays inside sizes anyone
has actually run. This is a deliberate, documented ceiling rather than an attempt to
find the true limit at the cost of the user's render.
"""

import time

import numpy as np


# mtlbvh's fix commit reports a clean result at this size; nothing published goes
# higher. Also the point past which a 22.7M-face BVH stops being a known quantity.
DEFAULT_MAX_SOURCE_FACES = 8_000_000

# Texels per BVH query batch. The full 4096^2 atlas is 16.7M texels; querying them in
# one call allocates several float32 (N,3) buffers at once, which is where a bake on a
# memory-pressured machine would fall over rather than in the BVH itself.
QUERY_CHUNK = 1_000_000


def _unit(v, axis=-1, eps=1e-12):
    """Normalize without dividing by zero — degenerate rows come back as zeros."""
    n = np.linalg.norm(v, axis=axis, keepdims=True)
    return np.divide(v, n, out=np.zeros_like(v), where=n > eps)


def compute_vertex_normals(vertices, faces):
    """Area-weighted vertex normals.

    Area weighting rather than uniform: the source mesh comes out of a marching-style
    decoder with wildly uneven triangle areas, and uniform averaging lets a cluster of
    slivers outvote the one large triangle that actually describes the surface.
    """
    v = vertices[faces]
    # Un-normalized cross product IS twice the triangle area times the unit normal,
    # so accumulating it raw gives area weighting for free.
    fn = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    out = np.zeros_like(vertices, dtype=np.float64)
    for i in range(3):
        np.add.at(out, faces[:, i], fn)
    return _unit(out).astype(np.float32)


def compute_uv_tangents(vertices, faces, uvs):
    """Per-vertex tangents AND chart handedness from UV derivatives (Lengyel).

    Returns ``(tangent, w)`` where ``w`` is per-vertex +/-1 — the sign of the UV
    triangle determinant. **The handedness is not optional and cannot be replaced by a
    global convention.** A UV unwrapper is free to mirror individual charts, and
    cumesh's ``uv_unwrap`` does: handedness is constant *within* a chart and mixed
    *across* charts on ordinary consistently-wound meshes. So ``cross(n, t)`` alone is
    correct only for the ``det > 0`` charts; on the mirrored ones the bitangent points
    the wrong way, the baked green channel is inverted, and bumps read as dents with a
    hard discontinuity at every chart seam. No single global sign fixes it, because
    both groups exist in the same atlas.

    Must be computed against the **exported** UVs — the ones a renderer will
    reconstruct its own TBN from. A V flip leaves the tangent invariant (both ``du.y``
    and ``det`` change sign, cancelling in the product) but negates ``w``, so feeding
    this the rasterization UVs instead would silently invert the handedness everywhere.
    """
    p = vertices[faces]
    t = uvs[faces]
    e1, e2 = p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]
    du1, du2 = t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]
    # Degenerate UV triangles (zero area in texture space) have no defined tangent.
    # Their determinant is ~0; guard it and let those faces contribute nothing rather
    # than exploding into NaN and poisoning every vertex they touch.
    det = du1[:, 0] * du2[:, 1] - du2[:, 0] * du1[:, 1]
    r = np.divide(1.0, det, out=np.zeros_like(det), where=np.abs(det) > 1e-12)
    tangent = (e1 * du2[:, 1:2] - e2 * du1[:, 1:2]) * r[:, None]
    out = np.zeros_like(vertices, dtype=np.float64)
    # Accumulate the SIGN, not the raw determinant: a chart's handedness is a property
    # of its orientation, and area-weighting it would let one large triangle flip the
    # frame for a vertex whose other faces disagree.
    wsum = np.zeros(len(vertices), dtype=np.float64)
    for i in range(3):
        np.add.at(out, faces[:, i], tangent)
        np.add.at(wsum, faces[:, i], np.sign(det))
    # A vertex on a chart seam can straddle both handednesses and sum to exactly 0;
    # +1 is the arbitrary-but-stable tie-break (such a vertex has no consistent frame
    # either way, and the seam is where the atlas already discontinues).
    w = np.where(wsum < 0.0, -1.0, 1.0)
    return out.astype(np.float32), w.astype(np.float32)


def decoder_to_export_space(arr):
    """Apply the axis swap `to_glb` performs on its way out.

    `o_voxel.postprocess.to_glb` converts to glTF's Y-up before returning:

        vertices[:, 1], vertices[:, 2] = vertices[:, 2], -vertices[:, 1]

    and does the same to its normals. So the mesh this module receives is already in
    export space while the captured source mesh is still in decoder space. Sampling
    one against the other without this produces a unit-length but essentially random
    normal map — measured on the reference render as a mean tangent-space z of ~0.06
    where a correct map sits near +0.9, with every mapped texel carrying tilt.

    Applied to the source (429K vertices) rather than to the per-texel query positions
    (2.6M) because it is the cheaper side, and to the source NORMALS too, so the
    encoded orientation is expressed in the same frame the exported mesh lives in.
    """
    out = np.array(arr, dtype=np.float32, copy=True)
    y = out[:, 1].copy()
    out[:, 1] = out[:, 2]
    out[:, 2] = -y
    return out


def _extract_mesh(glb):
    """Pull the single UV-mapped mesh out of whatever to_glb returned.

    trimesh hands back either a Trimesh or a Scene depending on version and content,
    and the bake needs exactly one mesh with UVs. Raise rather than guess: silently
    baking against the wrong geometry produces a plausible-looking normal map that is
    subtly wrong everywhere, which is far worse than a clear failure.
    """
    meshes = list(glb.geometry.values()) if hasattr(glb, 'geometry') else [glb]
    if len(meshes) != 1:
        raise ValueError(f"normal bake expects exactly one mesh, got {len(meshes)}")
    mesh = meshes[0]
    uv = getattr(getattr(mesh, 'visual', None), 'uv', None)
    if uv is None:
        raise ValueError("normal bake requires the exported mesh to carry UVs")
    return mesh, np.asarray(uv, dtype=np.float32)


def bake_normal_map(
    glb,
    source_vertices,
    source_faces,
    texture_size,
    max_source_faces=DEFAULT_MAX_SOURCE_FACES,
    simplify=None,
    verbose=False,
):
    """Attach a tangent-space normal map to `glb`, sampled from the source mesh.

    Mutates and returns `glb`. `simplify` is injected (the runner passes the ORIGINAL
    `fast_simplification.simplify`, because by bake time the module attribute has been
    replaced by the decimation-target patch — calling the patched one here would
    silently retarget the source cap to the viewer mesh's target and defeat the whole
    pass).
    """
    import torch
    import o_voxel.postprocess as pp
    import mtldiffrast.torch as dr
    from PIL import Image

    if not (getattr(pp, '_HAS_DR', False) and getattr(pp, '_BVH', None)):
        raise RuntimeError('normal bake needs the Metal rasterizer and BVH backends')

    t_start = time.time()
    mesh, uvs = _extract_mesh(glb)
    lo_v = np.asarray(mesh.vertices, dtype=np.float32)
    lo_f = np.asarray(mesh.faces, dtype=np.int32)

    src_v = np.asarray(source_vertices, dtype=np.float32)
    src_f = np.asarray(source_faces, dtype=np.int32)
    if len(src_f) > max_source_faces and simplify is not None:
        if verbose:
            print(f"  normal source: {len(src_f):,} -> {max_source_faces:,} faces", flush=True)
        src_v, src_f = simplify(src_v, src_f, 1.0 - (max_source_faces / len(src_f)))
        src_v = np.asarray(src_v, dtype=np.float32)
        src_f = np.asarray(src_f, dtype=np.int32)

    # The source's own smooth normals are what gets encoded. Face normals would give a
    # faceted map that reads as decoder noise at this triangle density. Computed in
    # decoder space, then both mesh and normals are moved into export space so the
    # BVH and the query positions agree.
    src_vn = decoder_to_export_space(compute_vertex_normals(src_v, src_f))
    src_v = decoder_to_export_space(src_v)

    # Mirror o_voxel's own device choice rather than reaching for MPS. Its comment
    # states the reasoning: on the Metal path "all GPU compute goes through Metal
    # kernels directly (mtldiffrast, mtlbvh, cumesh, flex_gemm) [and] CPU tensors on
    # Apple Silicon unified memory are directly GPU-accessible — no MPS overhead
    # needed", so it runs this whole stage on CPU tensors. Using MPS here would also
    # mix devices against the BVH, which is the failure mode trellis-mac's own
    # comments repeatedly warn about.
    device = torch.device('cpu') if getattr(pp, '_BACKEND', None) == 'metal' else torch.device('cuda')
    ctx = dr.MtlRasterizeContext() if getattr(pp, '_BACKEND', None) == 'metal' \
        else dr.RasterizeCudaContext()

    # Rasterize the EXPORTED mesh in UV space, exactly as the colour bake does: UVs to
    # clip space, z=0, w=1. Chunked over faces with the same face-id-in-alpha trick, so
    # a large atlas does not allocate one giant intermediate.
    # `to_glb` also flips V on its way out (`uvs[:, 1] = 1 - uvs[:, 1]`) to reconcile
    # glTF's bottom-up V with PNG's top-down rows. Its own base-colour bake rasterized
    # with the UNflipped UVs, so this has to undo the flip or the normal map comes out
    # mirrored vertically against the base colour it accompanies.
    uv_t = torch.as_tensor(uvs, device=device).clone()
    uv_t[:, 1] = 1.0 - uv_t[:, 1]
    lo_f_t = torch.as_tensor(lo_f, device=device, dtype=torch.int32)
    uv_clip = torch.cat([
        uv_t * 2 - 1,
        torch.zeros_like(uv_t[:, :1]),
        torch.ones_like(uv_t[:, :1]),
    ], dim=-1).unsqueeze(0)
    rast = torch.zeros((1, texture_size, texture_size, 4), device=device, dtype=torch.float32)
    for i in range(0, lo_f.shape[0], 100_000):
        chunk, _ = dr.rasterize(
            ctx, uv_clip, lo_f_t[i:i + 100_000], resolution=[texture_size, texture_size],
        )
        hit = chunk[..., 3:4] > 0
        chunk[..., 3:4] += i
        rast = torch.where(hit, chunk, rast)
    mask = rast[0, ..., 3] > 0

    # Per-texel geometry of the low-res surface: position (where to sample the source),
    # plus the tangent frame the result has to be expressed in.
    lo_v_t = torch.as_tensor(lo_v, device=device)
    # Prefer the normals `to_glb` already produced and converted — they are what a
    # renderer will actually shade with, so the tangent basis must be built from them
    # rather than from a re-derivation that can disagree at seams.
    lo_vn = np.asarray(mesh.vertex_normals, dtype=np.float32) \
        if getattr(mesh, 'vertex_normals', None) is not None \
        else compute_vertex_normals(lo_v, lo_f)
    lo_vn_t = torch.as_tensor(lo_vn, device=device)
    # Against the EXPORTED uvs, not the V-unflipped rasterization copy — see
    # compute_uv_tangents. `uv_t` is correct for rasterizing the atlas and wrong for
    # the tangent frame.
    lo_vt, lo_w = compute_uv_tangents(lo_v, lo_f, uvs)
    lo_vt_t = torch.as_tensor(lo_vt, device=device)
    lo_w_t = torch.as_tensor(lo_w, device=device)
    pos = dr.interpolate(lo_v_t.unsqueeze(0), rast, lo_f_t)[0][0][mask]
    n_lo = torch.nn.functional.normalize(
        dr.interpolate(lo_vn_t.unsqueeze(0), rast, lo_f_t)[0][0][mask], dim=-1)
    t_lo = dr.interpolate(lo_vt_t.unsqueeze(0), rast, lo_f_t)[0][0][mask]
    # Gram-Schmidt: re-orthogonalize the interpolated tangent against the interpolated
    # normal. Interpolation does not preserve orthogonality, and a skewed basis tilts
    # every sampled normal by a varying amount across each triangle.
    t_lo = torch.nn.functional.normalize(t_lo - n_lo * (t_lo * n_lo).sum(-1, keepdim=True), dim=-1)
    # Handedness-corrected bitangent. Interpolating w and taking its sign keeps the
    # per-texel frame consistent with the chart it lands in.
    w_lo = torch.sign(dr.interpolate(lo_w_t.reshape(-1, 1).unsqueeze(0), rast, lo_f_t)[0][0][mask])
    w_lo = torch.where(w_lo == 0, torch.ones_like(w_lo), w_lo)
    b_lo = torch.cross(n_lo, t_lo, dim=-1) * w_lo

    # The SAME BVH class o_voxel uses (cumesh auto-selects Metal vs CUDA), so this
    # pass cannot diverge from the base-colour bake's notion of the surface.
    bvh = pp._BVH(torch.as_tensor(src_v, device=device), torch.as_tensor(src_f, device=device))
    src_vn_t = torch.as_tensor(src_vn, device=pos.device)
    src_f_t = torch.as_tensor(src_f, device=pos.device, dtype=torch.long)

    out = torch.zeros((pos.shape[0], 3), device=pos.device, dtype=torch.float32)
    for start in range(0, pos.shape[0], QUERY_CHUNK):
        sl = slice(start, start + QUERY_CHUNK)
        _, face_id, uvw = bvh.unsigned_distance(pos[sl], return_uvw=True)
        # Interpolate the source's vertex normals at the hit barycentrics — this is the
        # high-resolution orientation the exported triangles can no longer express.
        n_hi = torch.nn.functional.normalize(
            (src_vn_t[src_f_t[face_id.long()]] * uvw.unsqueeze(-1)).sum(dim=1), dim=-1)
        # Re-orient into the low-res normal's hemisphere. The O-Voxel decoder
        # deliberately produces open surfaces and non-manifold geometry, so its face
        # winding is not globally consistent and area-weighted vertex normals point
        # inward across whole patches. Measured on the reference render: median
        # dot(n_hi, n_lo) was +0.976 while the MEAN was +0.127, i.e. most texels were
        # right and a large minority were inverted. The exported surface defines
        # outward here by construction, so agreeing with it is not a heuristic — a
        # tangent-space normal in the opposite hemisphere encodes nothing meaningful.
        flip = torch.where((n_hi * n_lo[sl]).sum(-1, keepdim=True) < 0, -1.0, 1.0)
        n_hi = n_hi * flip
        # Project into the low-res tangent basis.
        out[sl] = torch.stack([
            (n_hi * t_lo[sl]).sum(-1),
            (n_hi * b_lo[sl]).sum(-1),
            (n_hi * n_lo[sl]).sum(-1),
        ], dim=-1)
    out = torch.nn.functional.normalize(out, dim=-1)

    # Unmapped texels start flat (0,0,1) rather than black: a black normal texel
    # decodes to a zero-length vector and renders as a hole in the lighting.
    img = torch.zeros((texture_size, texture_size, 3), device=pos.device, dtype=torch.float32)
    img[..., 2] = 1.0
    img[mask] = out
    encoded = ((img * 0.5 + 0.5).clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()

    # Then DILATE into the gutter, exactly as `to_glb` does for its own base-colour and
    # metallic-roughness maps. Flat-filling alone is not enough: bilinear filtering at
    # every chart edge blends real normals toward flat, so each UV island renders with
    # a flattened rim. At ~1M faces the chart network is dense (the reference render
    # produced 89,515 clusters), which makes that a pervasive seam pattern rather than
    # an edge case. Best-effort — a missing/older cv2 costs the dilation, not the map.
    unmapped = (~mask).to(torch.uint8).cpu().numpy()
    if unmapped.any():
        try:
            import cv2
            encoded = cv2.inpaint(encoded, unmapped, 3, cv2.INPAINT_TELEA)
        except Exception as exc:  # noqa: BLE001 - degrade to the flat fill
            print(f"[portos] normal-map gutter dilation skipped ({type(exc).__name__}: {exc})",
                  flush=True)

    material = mesh.visual.material
    material.normalTexture = Image.fromarray(encoded, mode='RGB')
    if verbose:
        covered = int(mask.sum().item())
        # Reported separately from generate.py's own "Bake time", which bundles
        # to_glb's UV unwrap and attribute sampling. Without this the pass's real cost
        # is unmeasurable from a render log, and the UI's time claim is a guess.
        print(f"  normal map: {texture_size}x{texture_size}, {covered:,} texels covered "
              f"in {time.time() - t_start:.1f}s", flush=True)
    return glb

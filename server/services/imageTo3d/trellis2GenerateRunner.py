"""Run trellis-mac's generate.py with the exporter knobs upstream hardcodes.

All model loading, sampling, UV unwrapping, baking, and export remain upstream.
This adapter only widens interfaces that upstream pins to a constant, and every
override is applied by intercepting a *function call* or an argparse
registration -- never by rewriting upstream source -- so a version bump breaks
loudly here instead of silently producing different geometry.

Three overrides, each with its own reason for existing:

1. ``--texture-size 4096``. Microsoft TRELLIS.2's texture exporter accepts
   arbitrary atlas sizes and its official app exposes 4096, but trellis-mac's
   argparse wrapper caps the same exporter at 2048.

2. ``--decimation-target N``. This is the big one. ``generate.py`` clamps the
   baked mesh to ``min(200000, len(faces))`` before handing it to the Metal BVH.
   That constant was calibrated for the **512** pipeline, which decodes ~800K
   faces -- a sane 4x decimation. On ``1024_cascade`` the decoder emits ~22.7M
   faces, where the same constant is a 115x decimation that discards 99.1% of
   the geometry the render just spent minutes producing. o_voxel's own
   ``to_glb`` defaults ``decimation_target`` to 1_000_000, i.e. the baker is
   built for 5x more than upstream ever gives it.

   Upstream's stated reason for the clamp is that "the BVH builder is unstable
   on 800K+ face inputs" -- but that instability was a 24-slot traversal stack
   in mtlbvh that silently dropped subtrees, fixed in mtlbvh bc0a534 (traversal
   stack 24->64) which post-dates trellis-mac's last commit (2026-04-28). The
   clamp is a workaround for a bug that is no longer present in the pinned
   dependency set.

3. ``--fill-holes``. ``patches/mps_compat.py`` stubs ``Mesh.fill_holes`` to an
   unconditional ``return`` because the Metal cumesh port used to segfault on
   decoder-sized meshes; that segfault was fixed in mtlmesh 98047ac. Unlike the
   other two this is not a call intercept: the stub is upstream *source*, and
   the call site is inside TRELLIS.2's decode path rather than anywhere PortOS
   can reach at runtime. So an install step (``trellis2RestoreFillHoles.py``)
   rewrites the stub into an environment check, and this flag flips that env var
   on. A missing gate is a hard error rather than a silent fall-through -- the
   whole point of the flag is to not export a holey mesh.

   Deliberately opt-in, not default: the published evidence for the mtlmesh fix
   (trellis-mac#11) reaches a 2.99M-face mesh, while ``1024_cascade`` decodes
   ~22.7M, and the failure mode is a segfault that kills a render already ten
   minutes deep.

Order matters: every patch here must be installed BEFORE ``runpy`` executes
generate.py, because generate.py imports ``fast_simplification`` and
``o_voxel.postprocess`` lazily inside its bake branch -- so patching the module
attributes up front is what makes the interception take effect.

Importing ``o_voxel.postprocess`` this early is deliberate and measured, not an
oversight. generate.py defers it past diffusion, and an upstream comment claims
``flex_gemm``'s import "slows the diffusion hot path ~10x on MPS" -- but
generate.py *already* imports ``flex_gemm`` at module top to choose
``SPARSE_CONV_BACKEND``, so nothing new is loaded here. Measured cost on the
reference install: 2.21s for ``import o_voxel.postprocess`` against a 1.15s
bare-``torch`` baseline, i.e. ~1.1s once per process against a multi-minute
render.
"""

# ---------------------------------------------------------------------------
# ENV PREAMBLE — must run before ANY import that can pull torch.
#
# This adapter is now the process entry point, so it inherits an ordering
# constraint that used to be generate.py's alone. generate.py sets these with
# `setdefault` at ITS module top and documents why: "MPS fallback MUST be set
# before torch is imported anywhere (including transitively via flex_gemm).
# Without this, segment_reduce and a few other ops crash instead of falling back
# to CPU."
#
# When the adapter fronted only the 4K path and did nothing before `runpy`, that
# held automatically. It no longer does: `_patch_decimation_target` imports
# `o_voxel.postprocess`, which imports torch — so by the time generate.py ran its
# own setdefault, torch was already initialized and the flag was inert. The
# observable failure was `NotImplementedError: aten::segment_reduce is not
# currently implemented for the MPS device`, raised from the classifier-free
# guidance std() inside the first sampler step, i.e. every MPS render died ~3
# minutes in having produced nothing.
#
# `setdefault`, not assignment, so an explicit caller-supplied value still wins —
# and so this stays consistent with generate.py rather than fighting it.
import os

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("ATTN_BACKEND", "sdpa")
os.environ.setdefault("SPARSE_ATTN_BACKEND", "sdpa")
# ---------------------------------------------------------------------------

import argparse
import runpy
import sys
from pathlib import Path


UPSTREAM_TEXTURE_SIZES = [512, 1024, 2048]
PORTOS_TEXTURE_SIZES = [*UPSTREAM_TEXTURE_SIZES, 4096]

# The constant `generate.py` clamps its bake mesh to. Asserted, not assumed: if
# upstream retunes it, the interception below is measuring against the wrong
# baseline and must be revisited rather than silently applied.
UPSTREAM_DECIMATION_CLAMP = 200000

# Must match `GATE_ENV` in trellis2RestoreFillHoles.py, which installs the gate
# this flag flips on.
FILL_HOLES_ENV = "PORTOS_TRELLIS2_FILL_HOLES"


class AdapterContractError(RuntimeError):
    """Upstream changed an interface this adapter overrides."""


def _parse_adapter_args(argv):
    """Split PortOS's own flags off the front of argv.

    PortOS flags are consumed here and never reach generate.py's parser, which
    would reject them as unknown. The `--` separator keeps that split explicit
    rather than positional-guessing where upstream's argv begins.
    """
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--decimation-target", type=int, default=None)
    parser.add_argument("--fill-holes", action="store_true")
    parser.add_argument("--remesh", action="store_true")
    parser.add_argument("--mesh-cluster-refine-iterations", type=int, default=None)
    parser.add_argument("--mesh-cluster-smooth-strength", type=float, default=None)
    parser.add_argument("--alpha-mode", default=None,
                        choices=["OPAQUE", "auto", "BLEND", "MASK"])
    parser.add_argument("--normal-map", action="store_true")
    parser.add_argument("--normal-map-max-source-faces", type=int, default=None)
    known, rest = parser.parse_known_args(argv)
    if rest and rest[0] == "--":
        rest = rest[1:]
    return known, rest


def _patch_texture_size_choices():
    """Widen `--texture-size` to include the 4K atlas the exporter supports."""
    original_add_argument = argparse.ArgumentParser.add_argument

    def add_argument(parser, *name_or_flags, **kwargs):
        if "--texture-size" in name_or_flags:
            if kwargs.get("choices") != UPSTREAM_TEXTURE_SIZES:
                raise AdapterContractError(
                    "trellis-mac changed its texture-size interface; "
                    "the PortOS 4K adapter needs to be updated"
                )
            kwargs = {**kwargs, "choices": PORTOS_TEXTURE_SIZES}
        return original_add_argument(parser, *name_or_flags, **kwargs)

    argparse.ArgumentParser.add_argument = add_argument


def _patch_decimation_target(target):
    """Retarget the pre-bake mesh decimation from upstream's 200K clamp.

    Two interception points, and BOTH are required:

      * ``fast_simplification.simplify`` -- upstream derives a *ratio* from its
        200K clamp and passes that, so overriding the target means recomputing
        the ratio from the real face count at call time.
      * ``o_voxel.postprocess.to_glb`` -- it takes ``decimation_target`` too and
        would re-decimate straight back down to 200K, silently undoing the
        first patch. Missing this is the whole reason to write it down.

    Applied ONLY when the Metal bake path is live, gating on exactly the
    condition generate.py's own ``use_metal`` branch tests. On the pure-Python
    KDTree fallback the mesh goes through an xatlas UV unwrap, which is reported
    to hang on large inputs (trellis-mac#16, 789K triangles on an M1 Max) -- so
    raising the target there would trade "loses detail" for "never finishes".
    A degraded install therefore keeps upstream's 200K clamp, and says so.
    """
    import o_voxel.postprocess

    if not (getattr(o_voxel.postprocess, "_BACKEND", None) == "metal"
            and getattr(o_voxel.postprocess, "_HAS_DR", False)):
        print(
            "[portos] Metal bake backend unavailable - keeping upstream's "
            f"{UPSTREAM_DECIMATION_CLAMP} face clamp instead of the requested "
            f"{target} (the KDTree fallback's xatlas unwrap hangs on large meshes)",
            flush=True,
        )
        return

    import fast_simplification

    original_simplify = fast_simplification.simplify

    def simplify(points, faces, ratio=None, **kwargs):
        n_faces = len(faces)
        # generate.py prints "Simplifying mesh: N -> ~200,000 faces" BEFORE calling
        # this, unconditionally and from its own hardcoded clamp. That line is now a
        # lie, so say what actually happens — otherwise the log reads as though the
        # detail was discarded on exactly the renders where it was kept.
        if n_faces <= target:
            print(f"[portos] keeping all {n_faces:,} faces (target {target:,}) "
                  "- ignore the '-> ~200,000 faces' line above", flush=True)
            # Upstream would still call us here (its guard compares against 200K, not
            # against `target`), so no-op rather than decimate a mesh already small
            # enough.
            return points, faces
        print(f"[portos] decimating {n_faces:,} -> {target:,} faces "
              "- ignore the '-> ~200,000 faces' line above", flush=True)
        return original_simplify(points, faces, 1.0 - (target / n_faces), **kwargs)

    fast_simplification.simplify = simplify

    import o_voxel.postprocess

    original_to_glb = o_voxel.postprocess.to_glb

    def to_glb(*args, **kwargs):
        if kwargs.get("decimation_target") == UPSTREAM_DECIMATION_CLAMP:
            kwargs["decimation_target"] = target
        return original_to_glb(*args, **kwargs)

    o_voxel.postprocess.to_glb = to_glb


# Filled in by the simplify interception above; read by the normal-map bake. A
# module-level dict rather than a parameter because the producer (a patched
# third-party function) and the consumer (a patched third-party function) cannot
# pass anything to each other directly.
_CAPTURED = {}


def _patch_capture_source_mesh():
    """Record the mesh generate.py hands to `fast_simplification.simplify`.

    That call is the ONLY place the pre-decimation mesh is observable: generate.py
    simplifies first and passes the result to `to_glb`, so `to_glb`'s own notion of
    "original" is already the decimated mesh and holds no high-resolution surface to
    sample from.

    Installed independently of the decimation patch. Bundling the capture into that
    wrapper made `--normal-map` silently degrade to a no-op unless
    `--decimation-target` happened to be passed too — a dependency between two
    unrelated flags that nothing in the CLI expressed.
    """
    import fast_simplification

    # Installed BEFORE the decimation patch, which matters twice over:
    #   * `pristine` is then the genuine unpatched callable. The bake uses it to
    #     enforce its own source-face cap; going through the decimation wrapper
    #     instead would retarget that to the viewer mesh's face count and flatten
    #     the very detail the bake exists to recover.
    #   * this wrapper ends up INNERMOST, so it still observes the full mesh —
    #     the decimation wrapper only rewrites the ratio, never the vertices or
    #     faces it forwards.
    pristine = fast_simplification.simplify
    _CAPTURED["simplify"] = pristine

    def simplify(points, faces, *args, **kwargs):
        _CAPTURED["source"] = (points, faces)
        return pristine(points, faces, *args, **kwargs)

    fast_simplification.simplify = simplify


def _patch_normal_map(max_source_faces, verbose=True):
    """Bake a tangent-space normal map onto the exported mesh after `to_glb`.

    Wraps `to_glb` rather than running after generate.py finishes, because the
    in-memory trimesh object is the last point where the material can be given a
    texture — once generate.py has called `.export()`, adding one means rewriting
    the GLB container.

    A bake failure must NOT fail the render: the mesh and its base colour are
    already correct at this point, and a normal map is an enhancement. So this
    logs and returns the un-augmented GLB, which is exactly today's output.
    """
    import o_voxel.postprocess

    original_to_glb = o_voxel.postprocess.to_glb

    def to_glb(*args, **kwargs):
        glb = original_to_glb(*args, **kwargs)
        source = _CAPTURED.get("source")
        if source is None:
            print("[portos] normal map skipped - no pre-decimation mesh was captured "
                  "(the render never went through the simplify path)", flush=True)
            return glb
        try:
            # INSIDE the guard, deliberately. The bake module pulls numpy, torch,
            # mtlbvh, mtldiffrast and PIL; on an install missing any of them an
            # ImportError raised out here would kill a render that had already
            # produced a correct mesh and texture. Import failure is just one more
            # reason the enhancement is unavailable.
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from trellis2NormalBake import bake_normal_map, DEFAULT_MAX_SOURCE_FACES
            return bake_normal_map(
                glb,
                source[0],
                source[1],
                texture_size=kwargs.get("texture_size", 2048),
                max_source_faces=max_source_faces or DEFAULT_MAX_SOURCE_FACES,
                simplify=_CAPTURED.get("simplify"),
                verbose=verbose,
            )
        except Exception as exc:  # noqa: BLE001 - see docstring: never fail the render
            print(f"[portos] normal map bake failed ({type(exc).__name__}: {exc}) - "
                  "exporting without it", flush=True)
            return glb

    o_voxel.postprocess.to_glb = to_glb


def _patch_to_glb_quality(**overrides):
    """Forward o_voxel `to_glb` knobs upstream never passes.

    ``remesh`` / ``mesh_cluster_*`` / ``alpha_mode`` all default to something
    upstream leaves untouched. Only keys the caller actually set are forwarded,
    so an unset knob keeps the exporter's own default and this stays a no-op.
    """
    applied = {k: v for k, v in overrides.items() if v is not None and v is not False}
    if not applied:
        return

    import o_voxel.postprocess

    original_to_glb = o_voxel.postprocess.to_glb

    def to_glb(*args, **kwargs):
        return original_to_glb(*args, **{**kwargs, **applied})

    o_voxel.postprocess.to_glb = to_glb


def _enable_fill_holes(generate_dir):
    """Turn on decode-time hole filling, or fail loudly if the gate is missing.

    The gate is installed by `trellis2RestoreFillHoles.py` as an install/repair
    step; this only flips it on. Read from the source file rather than importing
    `trellis2.representations.mesh.base`, because that import pulls torch and the
    whole representations package for what is a one-line text check.

    Absence of the gate must NOT degrade to "render without hole filling": the
    user asked for it, so a stale install has to say so rather than quietly
    producing the exact output the flag exists to avoid.
    """
    base = (Path(generate_dir) / "TRELLIS.2" / "trellis2" / "representations"
            / "mesh" / "base.py")
    if not base.exists():
        raise AdapterContractError(f"--fill-holes requested but {base} is missing")
    if FILL_HOLES_ENV not in base.read_text():
        raise AdapterContractError(
            "--fill-holes was requested but trellis2/representations/mesh/base.py "
            "still carries the unconditional mps_compat stub. Repair the TRELLIS.2 "
            "install to add the gate."
        )
    os.environ[FILL_HOLES_ENV] = "1"


def main():
    adapter, upstream_argv = _parse_adapter_args(sys.argv[1:])
    if not upstream_argv:
        raise AdapterContractError(
            "trellis2GenerateRunner.py requires the upstream generate.py path"
        )

    generate_script = upstream_argv[0]
    generate_dir = str(Path(generate_script).resolve().parent)
    if generate_dir not in sys.path:
        # Direct `python generate.py` execution places the script directory first
        # on sys.path. Preserve that contract when the adapter uses runpy so the
        # upstream script can import its sibling packages.
        sys.path.insert(0, generate_dir)
    # generate.py puts TRELLIS.2/ on sys.path itself, but the fill-holes assert
    # below imports from it before generate.py runs, so it has to be reachable now.
    trellis_root = str(Path(generate_dir) / "TRELLIS.2")
    if trellis_root not in sys.path:
        sys.path.insert(0, trellis_root)

    _patch_texture_size_choices()
    # Before the decimation patch — see _patch_capture_source_mesh for why both the
    # pristine-callable and the innermost-wrapper properties depend on this order.
    if adapter.normal_map:
        _patch_capture_source_mesh()
    if adapter.decimation_target is not None:
        _patch_decimation_target(adapter.decimation_target)
    _patch_to_glb_quality(
        remesh=adapter.remesh,
        mesh_cluster_refine_iterations=adapter.mesh_cluster_refine_iterations,
        mesh_cluster_smooth_strength=adapter.mesh_cluster_smooth_strength,
        alpha_mode=adapter.alpha_mode,
    )
    if adapter.normal_map:
        _patch_normal_map(adapter.normal_map_max_source_faces)
    if adapter.fill_holes:
        _enable_fill_holes(generate_dir)

    sys.argv = [generate_script, *upstream_argv[1:]]
    runpy.run_path(generate_script, run_name="__main__")


if __name__ == "__main__":
    main()

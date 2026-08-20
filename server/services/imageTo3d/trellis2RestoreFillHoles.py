"""Convert trellis-mac's hard `fill_holes` stub into a runtime-gated one.

`patches/mps_compat.py` stubs `Mesh.fill_holes` to an unconditional `return`
because the Metal cumesh port used to segfault on decoder-sized meshes. That
segfault was fixed in mtlmesh 98047ac (O(F) bounds checks, int64 accumulation
with overflow guards, capped union-find), and trellis-mac has not shipped a
commit since 2026-04-28 -- so the stub outlives its cause and every render
exports a mesh with unfilled holes.

This script does NOT simply delete the stub, and the distinction matters.
Deleting it would re-enable hole filling *unconditionally*, because the call
site lives in TRELLIS.2's decode path rather than behind any flag PortOS
controls. The published evidence for the fix at scale (trellis-mac#11) reaches
a 1.44M-vertex / 2.99M-face mesh; a `1024_cascade` render on a large-memory Mac
decodes ~22.7M faces, which is ~7.6x beyond that. Turning an unproven code path
on by default -- where the failure mode is a segfault that destroys a render
already ten minutes deep -- is not a trade PortOS gets to make silently.

So the stub becomes an environment check instead. Absent the env var the
behaviour is byte-for-byte what it was; set it and the upstream implementation
runs. That keeps the default safe, makes the opt-in one flag on the render, and
leaves the mutation greppable on disk rather than reconstructed at runtime.

Idempotent: re-running finds the gate already in place and exits 0, so it is
safe as a repeated install/repair step. Fails loudly rather than silently
no-op'ing if upstream's stub text ever changes, because a silent no-op here
means the `--fill-holes` flag would appear to work and do nothing.
"""

import sys
from pathlib import Path


GATE_ENV = "PORTOS_TRELLIS2_FILL_HOLES"

# The exact line mps_compat.py injects. Matched literally (including the
# en dash) so a change upstream fails the assert instead of being papered over.
UPSTREAM_STUB = "        return  # Skip — Metal cumesh segfaults on large decode meshes\n"

GATED = (
    "        # PortOS: runtime-gated rather than hard-stubbed. The mtlmesh segfault\n"
    "        # this guarded was fixed in 98047ac, but the fix is only published as\n"
    "        # verified to ~2.99M faces, so opting in stays explicit.\n"
    "        import os\n"
    f"        if not os.environ.get({GATE_ENV!r}):\n"
    "            return\n"
)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: trellis2RestoreFillHoles.py <trellis2-root>")

    path = Path(sys.argv[1]) / "TRELLIS.2" / "trellis2" / "representations" / "mesh" / "base.py"
    if not path.exists():
        raise SystemExit(f"not found: {path}")

    # encoding="utf-8" is load-bearing, not hygiene. UPSTREAM_STUB contains an EN DASH,
    # and `read_text()` without an explicit codec uses the LOCALE default — cp1252 on a
    # Windows runner — which mangles it to "â€”" so the literal match silently fails and
    # this reports "upstream changed the patch". That failed only on Windows CI and
    # nowhere else. Same reason on the write side: round-tripping through cp1252 would
    # corrupt every non-ASCII byte in the file we are rewriting.
    source = path.read_text(encoding="utf-8")

    if GATE_ENV in source:
        print(f"[portos] fill_holes gate already present in {path.name}")
        return

    if UPSTREAM_STUB not in source:
        raise SystemExit(
            f"[portos] expected mps_compat's fill_holes stub in {path}, but it is not "
            "there. Upstream changed the patch; the PortOS fill-holes gate needs "
            "updating rather than guessing."
        )

    # Only the fill_holes stub carries the trailing comment, so a single literal
    # replace cannot touch the bare `return` stubs in remove_faces / simplify --
    # which stay stubbed deliberately: neither has the independent at-scale
    # evidence fill_holes has, and `simplify` additionally interacts with the
    # decimation-target override in trellis2GenerateRunner.py.
    path.write_text(source.replace(UPSTREAM_STUB, GATED, 1), encoding="utf-8")
    print(f"[portos] fill_holes is now gated on ${GATE_ENV} in {path.name}")


if __name__ == "__main__":
    main()

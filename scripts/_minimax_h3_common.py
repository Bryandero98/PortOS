"""Shared helpers for the two PortOS MiniMax H3 runners.

`generate_minimax_h3.py` drives PipeNetwork's Apple-Silicon MLX port and
`generate_minimax_h3_cuda.py` drives diffusers' `MiniMaxH3ModularPipeline` on
NVIDIA. They run in *different venvs* and load different pipelines, but they
present the same CLI to PortOS and enforce the same model facts — so everything
that is a property of the H3 checkpoint rather than of the runtime in front of
it belongs here, stated once.

Cross-venv sharing works the same way `_runner_common.py` already does: this
module is stdlib-only at import time (`huggingface_hub` and `PIL` are imported
inside the function that needs them), and both runners reach it through the
same-directory `sys.path.insert` idiom. Neither venv is forced to grow a
dependency it didn't already pin.

What must NOT move here: anything true of only one runner. The MLX port's
`resolve_transformer_snapshot` (its quantized DiT ships a separate
`quant_config.json`), its LoRA argument pairing, and the CUDA path's
`--repo-file` requirement and offload profiles all stay in their own runner.
The frame WINDOW is the subtle one — it differs between the two (diffusers
requires the snapped duration in 5-15s where the MLX port accepts 4-15s), so
`validate_h3_output_args` takes it as a parameter rather than asserting one.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

# H3 renders at a fixed 24 fps, and its video VAE can only decode a frame count
# on the 17n+5 grid. Both are checkpoint facts, identical on every runtime.
FPS = 24
FRAME_MODULUS = 17
FRAME_REMAINDER = 5


def snapshot_root(resolved_file: str | Path, repo_filename: str) -> Path:
    """Return the HF snapshot directory containing one resolved repo file."""
    levels = len(Path(repo_filename).parts)
    # Hugging Face snapshot entries are normally symlinks into `blobs/`.
    # Resolving the symlink would therefore walk OUT of the snapshot and hand
    # the pipeline a blob directory. `hf_hub_download` already returns an
    # absolute snapshot path, so preserve that lexical path deliberately.
    return Path(resolved_file).absolute().parents[levels - 1]


def resolve_cached_snapshot(repo: str, revision: str, required_files: list[str]) -> Path:
    """Resolve exact cached files without ever permitting a network fallback."""
    if not required_files:
        raise RuntimeError(f"No required files declared for {repo}.")

    from huggingface_hub import hf_hub_download

    resolved: list[tuple[str, Path]] = []
    for filename in required_files:
        try:
            path = hf_hub_download(
                repo_id=repo,
                filename=filename,
                revision=revision,
                local_files_only=True,
            )
        except Exception as exc:
            raise RuntimeError(
                f"Required cached weight is missing: {repo}@{revision[:12]}/{filename}. "
                "Use Download in Video Gen before generating."
            ) from exc
        resolved.append((filename, Path(path)))

    roots = {snapshot_root(path, filename) for filename, path in resolved}
    if len(roots) != 1:
        raise RuntimeError(f"Cached files for {repo}@{revision[:12]} span multiple snapshots; repair the model in Video Gen.")
    return roots.pop()


def require_ffmpeg() -> str:
    """Fail before loading tens of GB of weights when muxing cannot succeed."""
    path = shutil.which("ffmpeg")
    if path is None:
        raise RuntimeError("ffmpeg is required to mux MiniMax H3 video and audio; install it before generating.")
    return path


def emit_result(output: Path) -> None:
    """Emit the completion contract that arms PortOS's teardown watchdog."""
    print(json.dumps({"video_path": str(output)}), flush=True)


def validate_h3_output_args(
    args,
    *,
    min_frames: int,
    max_frames: int,
    frame_window_message: str,
) -> None:
    """Check every output constraint the H3 checkpoint imposes on both runners.

    `frame_window_message` is the one genuinely runtime-specific part: the two
    pipelines accept different duration windows on the same 17n+5 grid, so each
    runner supplies its own bounds and the sentence that explains them.

    Raises SystemExit so a bad request reports as a clean one-line runner error
    rather than a traceback (both runners' main() are invoked via SystemExit).
    """
    if args.fps != FPS:
        raise SystemExit(f"MiniMax H3 runs at a fixed {FPS} fps; got {args.fps}.")
    if args.width <= 0 or args.height <= 0 or args.width % 32 or args.height % 32:
        raise SystemExit(f"MiniMax H3 dimensions must be positive multiples of 32; got {args.width}x{args.height}.")
    if not min_frames <= args.num_frames <= max_frames:
        raise SystemExit(frame_window_message)
    if args.num_frames % FRAME_MODULUS != FRAME_REMAINDER:
        raise SystemExit(f"MiniMax H3 frame count must be 17n+5; got {args.num_frames}.")
    if args.steps < 2:
        raise SystemExit("MiniMax H3 needs at least 2 sigma grid points.")
    if len(args.anchor) != len(args.image):
        raise SystemExit(
            f"MiniMax H3 needs one --anchor per --image; got {len(args.image)} images and {len(args.anchor)} anchors."
        )
    # H3's fl2va conditioning defines exactly two latent anchors, so a repeated
    # anchor would silently overwrite one keyframe's position with another's.
    if len(set(args.anchor)) != len(args.anchor):
        raise SystemExit(f"MiniMax H3 anchors must be distinct; got {args.anchor}.")


def load_keyframes(paths: list[str]) -> list:
    """Open each conditioning image upright, in RGB, in the order given."""
    # Every path is checked before anything is opened, so a bad second keyframe
    # doesn't cost a decode of the first — and the message names the PortOS-side
    # cause rather than surfacing Pillow's bare FileNotFoundError.
    for path in paths:
        if not Path(path).is_file():
            raise RuntimeError(f"Conditioning image is missing: {path}")
    # Imported only once there is something to decode: a text-only run never
    # pulls Pillow in, and the missing-file path above stays dependency-free.
    if not paths:
        return []
    from PIL import Image, ImageOps

    images = []
    for path in paths:
        with Image.open(path) as handle:
            image = handle.convert("RGB")
        # In place: PortOS hands us ffmpeg-normalized PNGs with no orientation
        # tag, and the copying form would duplicate every pixel buffer for
        # nothing — then hold it across the multi-GB load that follows.
        ImageOps.exif_transpose(image, in_place=True)
        images.append(image)
    return images


__all__ = [
    "FPS",
    "FRAME_MODULUS",
    "FRAME_REMAINDER",
    "emit_result",
    "load_keyframes",
    "require_ffmpeg",
    "resolve_cached_snapshot",
    "snapshot_root",
    "validate_h3_output_args",
]

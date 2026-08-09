#!/usr/bin/env python3
"""Import-probe a pinned MiniMax H3 source package without trusting its root."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

from _runner_common import register_source_namespace


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: minimax_h3_runtime_probe.py <runtime-dir>")
    runtime_dir = Path(sys.argv[1]).resolve()
    package_dir = runtime_dir / "minimax_h3_mlx"
    if not (package_dir / "pipeline.py").is_file():
        raise RuntimeError(f"MiniMax H3 runtime source is missing under {runtime_dir}.")
    register_source_namespace("minimax_h3_mlx", package_dir)
    importlib.import_module("minimax_h3_mlx.pipeline")
    importlib.import_module("mlx_vlm.models.qwen3_vl.language")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Standalone tests for train_flux2_lora.py's memory-discipline invariants.

Run: python3 scripts/train_flux2_lora_test.py
Exits non-zero on first failure. Mirrors the runnable-test style of
scripts/train_mflux_lora_test.py.

These are AST checks on the source rather than behavioral tests, deliberately:
exercising the real code paths needs torch + a ~16 GB base download + a CUDA
card, which no test suite can carry. What they pin are the two invariants whose
absence made the torch trainer unusable on a 24 GB CUDA card (issue #2786) —
both silently survivable on a 128 GB unified-memory Mac, which is why neither
was caught by the original Apple-Silicon validation:

  1. Precompute runs under `torch.no_grad()`. Without it every `encode_prompt`
     retains its autograd graph — measured ~2.6 GB of Qwen3 activations pinned
     PER UNIQUE CAPTION, because the `.to("cpu")` cache copy inherits the
     `grad_fn`. Six captions exhausted the card.
  2. `render_sample` decodes on the training device. Precompute parks the VAE
     on CPU, and the pipeline is bf16 — x86 has no fast bf16 convolution path,
     so decoding there reads as a hang (>18 min for one 512-px decode).
"""
import ast
import sys
from pathlib import Path

# The ✅/❌ prefixes are cp1252-unencodable on a Windows console, which would
# abort the run before the first result printed. This trainer's whole point is
# the CUDA path, and that is where Windows lives — so force UTF-8 on stdout.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SRC = Path(__file__).resolve().parent / "train_flux2_lora.py"
TREE = ast.parse(SRC.read_text(encoding="utf-8"))

FAILS = []


def check(name, cond):
    print(("✅" if cond else "❌") + " " + name)
    if not cond:
        FAILS.append(name)


def func(name):
    for node in ast.walk(TREE):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


def calls(node):
    """Every call in `node`, rendered as a dotted name (e.g. torch.no_grad)."""
    out = []
    for n in ast.walk(node):
        if isinstance(n, ast.Call):
            parts, f = [], n.func
            while isinstance(f, ast.Attribute):
                parts.append(f.attr)
                f = f.value
            if isinstance(f, ast.Name):
                parts.append(f.id)
                out.append((".".join(reversed(parts)), n))
    return out


# --- 1. precompute is wrapped in torch.no_grad() -----------------------------
main = func("main")
check("main() exists", main is not None)

precompute_with = None
for node in ast.walk(main):
    if not isinstance(node, ast.With):
        continue
    for item in node.items:
        c = item.context_expr
        if (isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                and c.func.id == "heartbeat"
                and c.args and isinstance(c.args[0], ast.Constant)
                and c.args[0].value == "precompute-latents"):
            precompute_with = node

check("precompute-latents runs inside a `with` block", precompute_with is not None)

if precompute_with:
    guards = []
    for item in precompute_with.items:
        c = item.context_expr
        if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute):
            guards.append(c.func.attr)
    check(
        "precompute `with` includes torch.no_grad() "
        "(else ~2.6 GB leaks per caption — issue #2786)",
        "no_grad" in guards,
    )
    # The encode calls must be INSIDE that block, not merely nearby.
    inner = [n for n, _ in calls(precompute_with)]
    check("encode_prompt is inside the no_grad block",
          any(n.endswith("encode_prompt") for n in inner))
    check("_encode_vae_image is inside the no_grad block",
          any(n.endswith("_encode_vae_image") for n in inner))

# --- 2. render_sample decodes on the training device -------------------------
rs = func("render_sample")
check("render_sample() exists", rs is not None)

if rs:
    vae_to_device = False
    for name, call in calls(rs):
        # pipe.vae.to(device) — the move back onto the accelerator before decode.
        if name.endswith("vae.to") and any(
            isinstance(a, ast.Name) and a.id == "device" for a in call.args
        ):
            vae_to_device = True
    check(
        "render_sample moves the VAE onto `device` before decoding "
        "(bf16 conv on CPU hangs — issue #2786)",
        vae_to_device,
    )
    check("render_sample still calls vae.decode",
          any(n.endswith("vae.decode") for n, _ in calls(rs)))
    # It must be returned to where precompute parked it, or the training loop's
    # footprint silently grows by the VAE for the rest of the run.
    check("render_sample restores the VAE to its original device",
          any(n.endswith("vae.to") and any(
              isinstance(a, ast.Name) and a.id != "device" for a in c.args)
              for n, c in calls(rs)))

# --- 3. cache clearing is device-agnostic ------------------------------------
edc = func("empty_device_cache")
check("empty_device_cache() exists", edc is not None)

if edc:
    names = [n for n, _ in calls(edc)]
    check("empty_device_cache clears the MPS cache", "torch.mps.empty_cache" in names)
    check("empty_device_cache clears the CUDA cache", "torch.cuda.empty_cache" in names)

# No call site may go back to clearing only MPS — that was the original bug.
main_calls = [n for n, _ in calls(main)]
check("main() routes cache clears through empty_device_cache",
      main_calls.count("empty_device_cache") >= 3)
check("main() never calls torch.mps.empty_cache directly",
      "torch.mps.empty_cache" not in main_calls)

print()
if FAILS:
    print(f"❌ {len(FAILS)} check(s) failed: {', '.join(FAILS)}")
    sys.exit(1)
print("✅ all train_flux2_lora.py invariants hold")

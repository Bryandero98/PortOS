#!/usr/bin/env python3
"""Standalone tests for train_flux2_lora.py's memory-discipline invariants.

Run: python3 scripts/train_flux2_lora_test.py
Exits non-zero if any check fails. Mirrors the runnable-test style of
scripts/train_mflux_lora_test.py.

These are AST checks on the source rather than behavioral tests, deliberately:
exercising the real paths needs torch, a ~16 GB base download and a CUDA card,
which no test suite can carry. So they pin *structural* invariants only — each
one chosen because breaking it silently reintroduces a fault that made this
trainer unusable on a 24 GB card, and because no reasonable refactor breaks it
without also breaking the invariant. Background and measurements: issue #2786
and docs/research/2026-08-05-torch-flux2-lora-cuda-validation.md.
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
    """The named top-level function, or exit — a missing function would make
    every check about it vacuously pass."""
    for node in ast.walk(TREE):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    sys.exit(f"❌ {name}() not found in {SRC.name} — the file was restructured")


def calls(node):
    """Every call under `node` as (dotted_name, Call), e.g. pipe.vae.to."""
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


def names_in(call):
    """Identifiers passed to `call`, positionally or by keyword — so a check
    isn't defeated by `.to(device=device)` vs `.to(device)`."""
    args = list(call.args) + [k.value for k in call.keywords]
    return {a.id for a in args if isinstance(a, ast.Name)}


main = func("main")
main_calls = calls(main)

# --- 1. inference-only modules are frozen at load ----------------------------
# The root-cause form of the precompute leak: `requires_grad` is a property of
# the module, so clearing it makes "an inference forward silently built an
# autograd graph" unreachable from every call site, not just the wrapped one.
frozen = {
    name.rsplit(".", 2)[-2]
    for name, c in main_calls
    if name.endswith(".requires_grad_")
    and c.args and isinstance(c.args[0], ast.Constant) and c.args[0].value is False
}
for module in ("text_encoder", "vae", "transformer"):
    check(f"main() freezes {module} with requires_grad_(False) at load "
          f"(root-cause guard for the ~2.6 GB/caption leak — issue #2786)",
          module in frozen)

# --- 2. precompute's inference runs under torch.no_grad() --------------------
# Belt to the braces above. Located by walking every no_grad block in main()
# rather than by matching one `with` statement's shape, so nesting the guard or
# extracting precompute into its own block keeps passing.
no_grad_blocks = [
    n for n in ast.walk(main)
    if isinstance(n, ast.With) and any(
        isinstance(i.context_expr, ast.Call)
        and getattr(i.context_expr.func, "attr", None) == "no_grad"
        for i in n.items
    )
]
check("main() has a torch.no_grad() block", bool(no_grad_blocks))
for fn in ("encode_prompt", "_encode_vae_image"):
    check(f"precompute's {fn} runs under torch.no_grad()",
          any(any(n.endswith(fn) for n, _ in calls(b)) for b in no_grad_blocks))

# --- 3. render_sample decodes on the training device, and always restores ----
# Precompute parks the VAE on CPU, but the pipeline is bf16 and x86 has no fast
# bf16 conv path, so decoding there reads as a hang (>18 min for one 512-px
# decode). The restore must be in a `finally`: the caller treats samples as
# best-effort and swallows exceptions, so a throw mid-decode would otherwise
# strand the VAE on-device for the rest of the run.
rs = func("render_sample")
decode_try = None
for node in ast.walk(rs):
    if isinstance(node, ast.Try) and any(
        n.endswith("vae.decode") for n, _ in calls(node)
    ):
        decode_try = node

check("render_sample wraps vae.decode in a try (issue #2786)", decode_try is not None)

if decode_try:
    check("render_sample moves the VAE onto `device` inside that try "
          "(bf16 conv on CPU hangs — issue #2786)",
          any(n.endswith("vae.to") and "device" in names_in(c)
              for n, c in calls(ast.Module(body=decode_try.body, type_ignores=[]))))
    check("render_sample restores the VAE to `vae_home` in the try's finally",
          any(n.endswith("vae.to") and "vae_home" in names_in(c)
              for n, c in calls(ast.Module(body=decode_try.finalbody, type_ignores=[]))))

# --- 4. cache clearing goes through the shared, device-agnostic helper -------
# The original bug was an MPS-only `torch.mps.empty_cache()`, so a bare clear of
# EITHER backend is the regression — banning only the MPS spelling would let the
# mirror image straight back in.
module_calls = [n for n, _ in calls(TREE)]
check("no bare torch.mps/cuda.empty_cache anywhere in the module — "
      "clears route through _runner_common.empty_device_cache",
      not ({"torch.mps.empty_cache", "torch.cuda.empty_cache"} & set(module_calls)))
check("the trainer actually calls empty_device_cache",
      "empty_device_cache" in module_calls)
imported_from_common = any(
    isinstance(n, ast.ImportFrom) and n.module == "_runner_common"
    and any(a.name == "empty_device_cache" for a in n.names)
    for n in ast.walk(TREE)
)
redeclared_locally = any(
    isinstance(n, ast.FunctionDef) and n.name == "empty_device_cache"
    for n in ast.walk(TREE)
)
check("empty_device_cache comes from _runner_common, not a local re-declaration",
      imported_from_common and not redeclared_locally)

print()
if FAILS:
    print(f"❌ {len(FAILS)} check(s) failed:")
    for f in FAILS:
        print(f"   - {f}")
    sys.exit(1)
print("✅ all train_flux2_lora.py invariants hold")

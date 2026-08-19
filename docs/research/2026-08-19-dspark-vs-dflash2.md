# DSpark vs DFlash 2 — is DSpark worth adding alongside?

Date: 2026-08-19

Follow-up to [DFlash 2 speculative decoding](./2026-08-19-dflash2-speculative-decoding.md),
prompted by [ARahim3/mlx-dspark](https://github.com/ARahim3/mlx-dspark). Two
questions: is DSpark worth adding alongside DFlash 2, and is there Ollama
support for it?

## Verdict

**Yes — but the thing worth adding is a preset, not a backend, and DSpark turns
out to be the *more* available of the two on the engine PortOS already ships.**

The DFlash 2 note concluded "not adoptable today" partly because "PortOS
orchestrates no llama.cpp server." That is no longer true — PortOS now manages
`llama-server` directly (`server/services/llamaServerManager.js`, Settings →
Local LLMs), and its **Spec Type field is free text** that maps straight onto
llama.cpp's `--spec-type`. So the ranking flipped:

| Drafter family | llama.cpp status | Reachable from PortOS today |
| --- | --- | --- |
| **DSpark** | [#25173 **merged 2026-07-28**](https://github.com/ggml-org/llama.cpp/pull/25173) | **Yes** — `brew install llama.cpp`, `--spec-type draft-dspark` |
| DFlash (v1) | merged | Yes |
| DFlash 2 | [#27342 **still open**](https://github.com/ggml-org/llama.cpp/pull/27342) (last activity 2026-08-19) | Only from a source build of the PR branch |

PortOS's shipped presets pointed exclusively at DFlash 2 drafters — the one
family that needs an unmerged branch. DSpark needs **zero** new backend, zero
new dependency, and no server change: a `--spec-type` string and a drafter GGUF.
That is the whole cost, so it clears the surface-area bar the DFlash 2 note set.

**`mlx-dspark` itself is not worth adopting as a backend** — see below. Its
value here was as a signpost to the merged llama.cpp path.

## Is there Ollama support for DSpark?

**Partially, and not in a form PortOS can use.** Precisely:

- Ollama's **vendored llama.cpp engine has had DSpark since 0.32.6**
  ([#17545](https://github.com/ollama/ollama/pull/17545), merged 2026-08-04) —
  the engine can decode it.
- **Ollama surfaces no control for it.** `llm/llama_server.go` hardcodes
  `--spec-type draft-mtp` whenever speculative decoding is on, so a Modelfile
  `DRAFT` + `PARAMETER draft_num_predict` pairing selects MTP, never DSpark.
- The only working recipe is an **environment-variable override** on the Ollama
  server process — `LLAMA_ARG_SPEC_TYPE=draft-dspark`,
  `LLAMA_ARG_SPEC_DRAFT_N_MAX`, `LLAMA_ARG_SPEC_DRAFT_MODEL` pointed at a raw
  **blob-store sha256 path**, with `DRAFT` set but `draft_num_predict` left
  unset. The one reported measurement through that path was **~13%**, an order
  of magnitude below the 2–3× the drafter delivers natively.
- The feature request, [ollama#17016](https://github.com/ollama/ollama/issues/17016)
  (opened 2026-07-03), is **still open**. There is no `x/models/dspark` package
  (404) to match the `x/models/dflash` one.

A recipe that requires editing PortOS's own Ollama service environment and
hand-copying a content-addressed blob path is not something to wire into a UI.
**No Ollama work is warranted** — the DSpark path for PortOS is `llama-server`,
which PortOS already manages and where the flag is a first-class argument.

## What DSpark is, versus DFlash 2

Both are lossless EAGLE-family block drafters: a small head proposes several
tokens, the target verifies them in one pass, and greedy output is unchanged.
They differ in how they fight *suffix decay* (later positions in a block are
guessed without knowing the earlier ones):

- **DFlash 2** — block diffusion. Keeps the top-16 candidates per position and
  adds a bilinear selector plus two-tap depthwise convolutions to trace one
  coherent path. Both live in the engine, which is why #27342 is a real code
  change and not just a checkpoint.
- **DSpark** (DeepSeek, [arXiv:2607.05147](https://arxiv.org/html/2607.05147v1))
  — a 5-layer parallel backbone over the target's hidden states plus a
  **rank-256 Markov head** that conditions each drafted token on the previously
  sampled one, and a confidence head for adaptive block length. In llama.cpp it
  is layered on the already-merged DFlash drafter machinery, which is why it
  landed as a smaller patch and merged first.

Head-to-head on the same target (`mlx-dspark`'s M4 Pro benchmarks,
Qwen3.8-27B 8-bit) they are close — DFlash 2 measures **3.63×** and DSpark's
hybrid **2.72×**. DFlash 2 is the faster algorithm where it runs. Availability,
not throughput, is what separates them for PortOS today.

DSpark also has far **wider target coverage**: DeepSeek ships official heads for
Qwen3 4B/8B/14B, and the community has published drafters for DeepSeek-V4-Flash,
Kimi-K3, GLM-5.2, Gemma-4, Nemotron, Muse-Glimmer and Bonsai. DFlash 2's
published set is much narrower.

## Why `mlx-dspark` is not a backend PortOS should adopt

[ARahim3/mlx-dspark](https://github.com/ARahim3/mlx-dspark) (MIT, ~450 stars,
active) is a genuinely nice piece of work: a native MLX port of both DSpark and
DFlash, a drafter registry that auto-resolves target→drafter pairs, per-machine
calibration, and an OpenAI- *and* Anthropic-compatible server. Adopting it would
still be wrong:

- It is a **fourth local inference backend** (after Ollama, LM Studio, and
  `llama-server`) — pip-installed, Apple-Silicon-only, Python ≥3.10, MLX
  safetensors only, **no GGUF** — bought for a speedup PortOS can already get
  through a backend it manages. That is the same trade the DFlash 2 note and the
  [Qwen3.8 27B MLX evaluation](./2026-08-16-qwen38-mlx-macos.md) both declined.
- **A user who wants it needs nothing from PortOS.** `mlx-dspark serve` listens
  on `127.0.0.1:8080` and speaks `/v1/chat/completions` and `/v1/models` — the
  exact endpoint the shipped `opencode-llama-tui` provider preset already points
  at. Stop `llama-server`, start `mlx-dspark serve`, hit **Refresh Models**. Any
  integration PortOS wrote would duplicate that for no gain.
- Its own caveats narrow the win further: MoE targets (Nemotron 1.10×,
  Qwen3.6-35B-A3B 1.32×) and 2-bit Bonsai (1.07×) barely clear break-even, and
  hybrid targets can't batch.

Its **drafter registry is worth borrowing as data, not code** — it is the best
published target→drafter mapping for both families, and the source for the
preset drafter names added here.

## What shipped with this note

Two changes, both small and both consequences of the investigation.

### 1. DSpark presets on the llama-server launcher

`client/src/components/settings/LocalLlmTab.jsx`: `DFLASH_PRESETS` →
`SPEC_DECODE_PRESETS`, with two `draft-dspark` presets leading (Qwen3.8-27B and
Qwen3-8B) and the DFlash 2 presets kept but relabelled with the build they
require. The default selection and the form's initial `specType` move to
`draft-dspark`, so the out-of-box preset is one a stock Homebrew `llama.cpp`
can actually run. No server change — `specType` was already a pass-through
string, and `alias` stays `dflash` so the `opencode-llama-tui` provider's
default model alias keeps resolving.

Note for anyone reading the DFlash 2 presets: llama.cpp **silently falls back**
on a spec-type/drafter mismatch rather than erroring, so a DFlash 2 drafter run
against stock `--spec-type draft-dflash` degrades quietly instead of failing
loudly. The relabelled preset names are the warning.

### 2. DSpark drafters filtered out of the MLX model search

Same hazard the DFlash 2 note fixed, same class, new family. The MLX branch of
`server/services/huggingFaceCatalog.js` matched `mtp|dflash\d*|drafter` in the
repo name; `dspark` joins it, because a real mlx-community repo slips the tag
predicate:

`mlx-community/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-DSpark-bf16` declares
`mlx`, `dspark` and `speculative-decoding` — **but no `draft-model` tag**. Under
the shipped filter PortOS offered it as a normal one-click LM Studio MLX
install, handing the user a 30B target's sidecar that cannot chat. Covered by a
new test in `huggingFaceCatalog.test.js` (verified failing before the fix).

**Residual, accepted — the GGUF branch is left alone.** Sampling the 40
most-downloaded `dspark` repos on Hugging Face, roughly half of the GGUF ones
carry no `draft-model`/`drafter` tag (`YanissAmz/DeepSeek-V4-Flash-DSpark-draft-GGUF`,
`Lucebox/DeepSeek-V4-Flash-0731-DSpark-GGUF`, `magnitudedev/Qwen3.8-27B-DSpark-GGUF`,
…), so the tag predicate misses them. Widening the GGUF filter to match `dspark`
in the *name* is what the DFlash 2 note explicitly rejected for this branch, and
the reason holds here: that space also contains repos whose names carry `dspark`
while shipping a complete model (abliterated/merged DeepSeek-V4-Flash variants),
so a name match would hide mainstream installs — the worse failure. The MLX
space stays curated enough for name matching; the GGUF long tail does not.

## When to re-evaluate

- **DFlash 2 merges into llama.cpp master (#27342).** Then both families run on
  a stock build, DFlash 2's higher measured speedup becomes the reason to prefer
  it, and the preset ordering here should flip back. This is the same trigger
  already tracked in [#4568](https://github.com/atomantic/PortOS/issues/4568).
- **Ollama surfaces a real DSpark control** (closing
  [ollama#17016](https://github.com/ollama/ollama/issues/17016) with a Modelfile
  directive or a `spec_type` parameter, not the `LLAMA_ARG_*` workaround). Then
  the Ollama backend — which serves the Claude-Ollama and OpenCode-Ollama
  providers — gets the speedup too, and PortOS's work is again a catalog entry.

## Sources

- [ARahim3/mlx-dspark](https://github.com/ARahim3/mlx-dspark) — MLX port, benchmarks, drafter registry
- [DSpark paper — arXiv:2607.05147](https://arxiv.org/html/2607.05147v1) · [DSpark in SGLang](https://www.lmsys.org/blog/2026-07-06-dspark-sglang/)
- [llama.cpp #25173 — spec: add DSpark speculative decoding](https://github.com/ggml-org/llama.cpp/pull/25173) (merged 2026-07-28)
- [llama.cpp #27342 — spec: add DFlash2 support](https://github.com/ggml-org/llama.cpp/pull/27342) (open)
- [ollama #17016 — dspark option](https://github.com/ollama/ollama/issues/17016) · [ollama #17545 — llama.cpp update](https://github.com/ollama/ollama/pull/17545) (merged 2026-08-04)
- [DFlash 2 speculative decoding](./2026-08-19-dflash2-speculative-decoding.md) — the prior evaluation this revises
- [Qwen3.8 27B MLX options on macOS](./2026-08-16-qwen38-mlx-macos.md) — the original sidecar decision

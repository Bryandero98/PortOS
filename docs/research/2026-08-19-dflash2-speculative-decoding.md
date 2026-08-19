# DFlash 2 speculative decoding — can PortOS run Qwen this way?

Date: 2026-08-19

Evaluation of [DFlash 2](https://inco.ai/blog/dflash2/) as a way to run the Qwen
models faster across PortOS's local AI provider stack: the Ollama backend, the
Claude-Ollama TUI provider, and the OpenCode-Ollama TUI provider.

## Verdict

**Not adoptable today, through any backend PortOS orchestrates.** DFlash 2 is a
drafter checkpoint plus engine-side decoding machinery, and every engine that
can run it is either one PortOS does not orchestrate (vLLM, SGLang) or reachable
only from an unmerged pull request (llama.cpp). Ollama — the backend that
actually serves all three providers named above — ships DFlash *v1* on its MLX
runner and has no DFlash 2 modules, no `-dflash` tag for the Qwen3.8 targets,
and an open credibility problem with the DFlash tag it does publish.

No PortOS feature is warranted. What the evaluation *did* surface was a live
hazard the DFlash 2 release makes worse, which is fixed in the same change —
see [What shipped instead](#what-shipped-instead).

## What DFlash 2 is

A speculative-decoding algorithm, not a quantization format, a sampling setting,
or a model. A small drafter proposes a block of tokens and the target model
verifies the whole block in one forward pass. DFlash 2 adds two modules on top
of DFlash:

- **Parallel path selection** — keeps the top 16 candidates per position, scores
  adjacent pairs with a small bilinear attention, and traces one coherent path
  by dynamic programming (~2M extra parameters).
- **Suffix decay correction** — a two-tap dynamic depthwise convolution before
  and after each attention and feed-forward sublayer, so information crosses the
  block while positions still compute in parallel (~3% extra parameters).

Reported at 2.7–3.4× decode throughput on Qwen3.8-27B. Both modules live in the
*engine*, which is why the drafter weights alone are not enough.

## Why it cannot reach PortOS's stack

### The TUI providers are not the integration point

The Claude-Ollama and OpenCode-Ollama providers are HTTP clients of the Ollama
daemon (`isOllamaBackedProvider` in `server/lib/aiToolkit/internal/ollamaBacked.js`
is the whole relationship — a base URL and a model list). Decoding strategy is
invisible to them: if the daemon decoded speculatively, both would get the
speedup with zero PortOS changes. So "implement DFlash 2 in the TUI providers"
is not a task that exists. The entire question is whether the daemon can do it.

### Ollama — no

Verified against Ollama 0.32.14:

- Ollama has `x/models/dflash`, documented as a "DFlash block-diffusion draft
  model: qwen3-shaped layers drafting a whole block per forward". That is
  DFlash **v1**. It has no candidate selector and no depthwise-convolution taps,
  so a DFlash 2 checkpoint's extra tensors have nowhere to load.
- `ollama create` does expose the drafter pairing (`DRAFT` directive,
  `--draft-quantize`), but pairing is not the missing piece — the verify-side
  algorithm is.
- The `qwen3.8:27b` tag list carries `-mlx`, `-nvfp4`, `-mxfp8`, `-q4_K_M`,
  `-q8_0` and `-mtp-*` variants. There is **no** `-dflash` tag for it at all.
- The one DFlash tag Ollama does publish for another model was reported to
  decode at the same tokens/second as the non-DFlash build, and the issue was
  closed as not planned. Even the v1 path is not demonstrably live.

### LM Studio — no

LM Studio's speculative decoding pairs a target with a drafter that shares its
vocabulary, and its MTP support keys on models with a **built-in** MTP head.
Neither path knows the DFlash 2 architecture.

### llama.cpp, vLLM, SGLang — real, but out of reach

Support exists in all three and in none of them as a release:

| Engine | DFlash 2 status | Why PortOS can't use it |
| --- | --- | --- |
| llama.cpp | PR #27342, open (2026-08-18) | Needs a from-source CMake build of an unmerged branch; PortOS orchestrates no llama.cpp server |
| vLLM | PR #52816, unmerged | Installed from a PR ref; Python serving stack PortOS does not manage |
| SGLang | PR #35371, unmerged | Same |
| oMLX | prebuilt DMG, GUI-configured | A separate third-party app, not a PortOS-managed backend |

Adopting any of them means PortOS taking on a *third* local inference backend —
one built from an unmerged patch, on hardware assumptions PortOS does not make —
to chase a speedup on one model family. That fails the project's own bar for
adding surface area, and it is the same conclusion the
[Qwen3.8 27B MLX evaluation](./2026-08-16-qwen38-mlx-macos.md) reached about
MTP sidecars three days earlier: the complete, engine-native model is the
correct integration boundary, and PortOS does not own a speculative pairing
runtime.

## When to re-evaluate

Re-open this when **either** holds, because either one removes all the work:

1. Ollama publishes a packaged DFlash 2 tag for a Qwen target (a
   `qwen3.8:27b-dflash2`-shaped tag that resolves to one self-contained model),
   **and** it measurably decodes faster than `qwen3.8:27b-mlx` on the same box.
2. llama.cpp #27342 merges **and** Ollama's vendored engine picks it up.

Either way PortOS's work is a catalog entry, not a backend. Tracked in
[#4568](https://github.com/atomantic/PortOS/issues/4568) so the trigger does not
live only in this note.

## What shipped instead

DFlash 2's release put a new hazard into PortOS's live Hugging Face model
search. Drafter checkpoints are non-standalone: `incoai/Qwen3.8-27B-DFlash2` is
~2B of sidecar for a 27B target and produces nothing usable on its own. The
catalog already excluded MTP/drafter repos — but **only on the MLX branch**. The
GGUF branch had no drafter filter at all, and DFlash 2 ships GGUF drafters
(`incoai/Qwen3.8-27B-DFlash2-GGUF`, `z-lab/…`, and a growing long tail), so
searching a Qwen model in PortOS could offer one as a normal one-click Ollama or
LM Studio install. The user would get a model that cannot chat.

`server/services/huggingFaceCatalog.js` now filters both branches. The predicate
is deliberately narrow — the publisher's own `draft-model` / `drafter` tag:

Measured over one sample of 960 popular GGUF/MLX repos (the top downloads for
twelve common model queries, both formats):

- An `mtp` or `speculative-decoding` **tag** matches 68 of them (7.1%), the large
  majority being *complete* models that merely preserve a built-in MTP head
  (`unsloth/Qwen3.6-27B-MTP-GGUF`, `huihui-ai/Huihui-Qwen3.6-27B-abliterated-MTP-GGUF`).
  Filtering on those would hide mainstream installs — a worse failure than the
  one being fixed.
- The `draft-model` / `drafter` tag matches 6 (0.6%), all of them genuine drafter
  sidecars.

The MLX branch keeps its pre-existing repo-name matching (that space is curated,
so a `-MTP-`/`-DFlash-` suffix is reliable there) and gains `dflash\d*` so an
MLX-published DFlash drafter is caught too.

Residual, accepted: a few GGUF drafters declare no drafter tag and no
distinguishing pipeline (`Anbeeld/Qwen3.6-27B-DFlash-GGUF`,
`Alittlehammmer/Qwen3.6-27B-DFlash-GGUF-llama.cpp`). Nothing in their metadata
separates them from a complete model, and guessing from the name is what takes
out the mainstream repos above.

## Sources

- [DFlash 2 announcement](https://inco.ai/blog/dflash2/)
- [DFlash paper](https://arxiv.org/abs/2602.06036) · [z-lab/dflash](https://github.com/z-lab/dflash)
- [`incoai/Qwen3.8-27B-DFlash2`](https://huggingface.co/incoai/Qwen3.8-27B-DFlash2) · [GGUF build](https://huggingface.co/incoai/Qwen3.8-27B-DFlash2-GGUF)
- [llama.cpp #27342 — spec: add DFlash2 support](https://github.com/ggml-org/llama.cpp/pull/27342)
- [Ollama `x/models/dflash`](https://pkg.go.dev/github.com/ollama/ollama/x/models/dflash)
- [Ollama #17683 — DFlash does not seem to be working](https://github.com/ollama/ollama/issues/17683)
- [LM Studio speculative decoding](https://lmstudio.ai/docs/app/advanced/speculative-decoding)
- [Qwen3.8 27B MLX options on macOS](./2026-08-16-qwen38-mlx-macos.md) — the prior sidecar decision

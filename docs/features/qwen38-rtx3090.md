# vLLM Qwen3.8-27B (DFlash 2) on an RTX 3090

[syv-ai/qwen38-27b-rtx3090](https://github.com/syv-ai/qwen38-27b-rtx3090) is a
frozen, reproducible packaging of patched vLLM 0.27.1 + a requantized
Qwen3.8-27B + a Docker compose file, targeted at **one specific card**: a 24 GB
RTX 3090. It serves an OpenAI-compatible API with DFlash 2 speculative drafting
and prefix caching turned on.

PortOS fronts it the same way it fronts [MTPLX](./mtplx.md) and the
[llama-server DSpark/DFlash 2 setup](./dflash2.md): as a local OpenAI-compatible
daemon behind two OpenCode wrappers. Nothing about the engine is vendored here —
PortOS talks to `http://127.0.0.1:18020/v1` and nothing more.

## Two hard constraints, before anything else

**It holds the entire GPU.** The stack occupies roughly 23 GB of the 3090's
24 GB. Local image and video generation on the same card cannot run alongside
it. There is no arbitration in PortOS: stop the container before a media job, or
run media generation on a different machine. This is also why PortOS never
auto-starts it — a container that came up on boot would silently take the card
away from whatever else the box does.

**Apple Silicon is not supported.** DFlash 2 has not been proven on Apple
Silicon in this project, and this is a CUDA / Marlin / FlashInfer container —
it will not run on a Mac at all. The readiness checklist says so on `darwin`
rather than offering a button that cannot work. Mac users wanting the same shape
(a local OpenAI-compatible daemon under an OpenCode TUI) already have
[MTPLX](./mtplx.md) and [DSpark](./dflash2.md).

## Why OpenCode and not Claude Code

vLLM speaks the OpenAI API. Claude Code speaks the Anthropic Messages API, so
pointing it here would mean running a LiteLLM translation layer in between —
another process to install, run, and debug for no capability gain. OpenCode
talks to an OpenAI-compatible endpoint natively, which is exactly what
`OPENCODE_CONFIG_CONTENT` already declares for Ollama, MTPLX, and llama.cpp.

## What PortOS adds

After this version is installed, the **AI Providers** page includes two disabled
presets:

- **OpenCode vLLM (Qwen3.8-27B)** — a headless `cli` coding-agent provider.
- **OpenCode vLLM TUI (Qwen3.8-27B)** — the attachable `tui` provider CoS agent
  tasks run in.

Both are disabled, hold a blank API key, and point at
`http://127.0.0.1:18020/v1`. No API-only preset ships: the container is
key-gated and the two coding harnesses cover everything a text-only record
would.

## Setup

### 1. Prepare the stack (operator, on the 3090 host)

This step is yours, in a terminal. PortOS does not clone the project, pull the
~9.5 GB image, or download the ~20 GB of weights — those are decisions with a
bandwidth and disk cost, and a button that started them by surprise would be the
wrong default.

On Windows you need WSL2 with Docker and the NVIDIA Container Toolkit (driver
≥ 580 / CUDA 13); on Linux, the same toolkit natively.

```bash
git clone https://github.com/syv-ai/qwen38-27b-rtx3090 ~/qwen-serving
cd ~/qwen-serving
echo "VLLM_API_KEY=$(openssl rand -hex 24)" > .env
printf 'SPEC=dflash2\nPREFIX_CACHE=1\n' >> .env
docker compose --profile single up -d
```

If startup dies on memory, upstream's escape hatches are `GPU_UTIL=0.93` and
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False` in `.env`. Capping board
power with `nvidia-smi -pl 250` is worth doing on a 3090.

Confirm it serves before touching PortOS:

```bash
curl -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:18020/v1/models
```

On Windows, confirm the same URL answers from the PortOS side too — Docker
Desktop / WSL2 localhost forwarding is what makes a container in the VM
reachable at `127.0.0.1` on the host.

**`DFLASH_TOKENS=15` is deliberately not a default.** It is the setting behind
the headline throughput number, but it costs KV cache: 56k context across 4
slots is too tight for CoS agent prompts, which carry a repo's worth of files.
Lookup drafting stays on either way. Set it in `.env` yourself if you have a
workload that fits.

### 2. Enable the provider (PortOS)

1. On **AI Providers**, enable **OpenCode vLLM TUI (Qwen3.8-27B)**.
2. Paste the `VLLM_API_KEY` from your `.env` into the provider's API key field.
   PortOS injects it into the spawned OpenCode's `provider.vllm.options.apiKey`;
   without it the container answers 401 and the model list stays empty.
3. Click **Refresh Models**. The served model should appear; the seeded alias is
   `qwen3.8-27b`, so update the default model if your container publishes a
   different id.
4. Assign the provider to a CoS agent task.

The provider card's requirements checklist probes `:18020` directly. Its
**Start** button runs `docker compose --profile single up -d` — but only when it
can see a prepared project (a compose file in `~/qwen-serving`, or wherever
`VLLM_QWEN_PROJECT_DIR` points) **and** confirm the weights are already cached.
It never pulls. If your HuggingFace cache lives in a docker named volume PortOS
cannot see — the normal case on Windows — the button says so and asks you to
start compose yourself, or to point `VLLM_QWEN_WEIGHTS_DIR` at the cache.

## What the numbers mean

The ~381 tok/s figure quoted upstream is *document reproduction*: 15 of 16
drafted tokens accepted straight from the context lookup. Ordinary chat is
around 133 tok/s. A coding agent — files in context, patches written back — sits
between the two, which is the workload the speculative path is actually for.
Prefix caching is the other half: on a 25k-token document, upstream measured
time-to-first-token dropping from 22.4 s on the first turn to 0.56 s on the
follow-up, which is what makes a multi-turn TUI session feel different from a
one-shot completion.

## Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `VLLM_QWEN_PROJECT_DIR` | `~/qwen-serving` | Where the compose project was cloned. |
| `VLLM_QWEN_WEIGHTS_DIR` | *(unset)* | HuggingFace hub cache holding the weights, when PortOS cannot find it — e.g. a docker named volume bind-mounted elsewhere. |

## Related

- [MTPLX](./mtplx.md) — the Apple Silicon native-MTP equivalent.
- [DFlash 2 / DSpark on llama.cpp](./dflash2.md) — the llama-server path, and the
  2026-08-19 evaluation that concluded PortOS should not vendor an unmerged
  engine patch. That conclusion still holds; what changed is that upstream froze
  a working container for this exact card, so PortOS points at it instead of
  building it.
- [docs/PORTS.md](../PORTS.md) — why `:18020` sits outside the 5553–5569 range.

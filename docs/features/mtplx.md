# MTPLX — native-MTP Qwen on Apple Silicon

[MTPLX](https://github.com/youssofal/MTPLX) is a separately managed local
runtime for Apple Silicon that can run Qwen checkpoints with native
multi-token-prediction (MTP) decoding. It exposes OpenAI-compatible and
Anthropic-compatible local APIs; PortOS uses its OpenAI-compatible endpoint.

This is an additional runtime, not an Ollama replacement. PortOS offers
**Qwen3.8 27B** through Ollama's GGUF path on supported hosts and, on Apple
Silicon, recommends native MLX builds for both Ollama and LM Studio. MTPLX's
native-MTP checkpoints remain a distinct runtime: PortOS maps only the known
packaged Ollama and LM Studio MLX equivalents and does not treat an MTP sidecar
as a standalone chat model.

## What PortOS adds

After this version is installed, the **AI Providers** page includes three
disabled presets:

- **MTPLX (local MTP)** — an `api` provider for ordinary text-generation tasks.
- **OpenCode MTPLX (local MTP)** — a headless `cli` coding-agent provider.
- **OpenCode MTPLX TUI (local MTP)** — an attachable `tui` coding-agent provider.

The two OpenCode variants give CoS agents a file-writing tool harness. The API
variant returns text only, like the existing Ollama API provider, so it is not a
valid CoS coding-agent runner.

## Setup

1. On **AI Providers**, enable the matching preset. Its card shows an MTPLX
   requirements checklist (installed / server responding / model available).
2. Click **Install & start MTPLX** on that checklist. PortOS installs the
   package from upstream's Homebrew tap (`brew install youssofal/mtplx/mtplx`),
   falling back to `python3 -m pip install mtplx` on a host without Homebrew,
   then runs `mtplx serve --port <the port your provider points at> --model <a
   model already in your MTPLX cache>` and waits for `/v1/models` to answer.
   Progress streams into the install modal.
3. **If no weights are cached**, the checklist says so on the "server
   responding" and "model available" rows — MTPLX's server exits before it
   binds a port with an empty cache — and the button becomes **Download the
   default model & start MTPLX**. That runs `mtplx pull` (MTPLX's own default
   verified checkpoint, a multi-gigabyte download) and then starts the server,
   with the download's progress streaming into the same modal. To use a
   different MTP checkpoint instead, run `mtplx pull <hf-repo-id>` in a
   terminal and click **Start MTPLX**.
4. Use **Refresh Models** once the server is up; PortOS then reads `/v1/models`
   on demand. The seed model alias is `mtplx` — refresh it if your running
   server publishes a different one.
5. Choose **MTPLX (local MTP)** for supported non-coding tasks, or choose an
   **OpenCode MTPLX** CLI/TUI preset for a CoS coding task.

Prefer to run it yourself? Install MTPLX per its upstream documentation and
start a server on the loopback OpenAI-compatible endpoint the preset points at,
`http://127.0.0.1:8000/v1`. The checklist notices and collapses to a ready pill.

### What the button does and does not do

- It installs the MTPLX package and starts its **API server only**. Upstream's
  optional `mtplx max --install` fan-control helper — the one privileged path
  in that project — is never invoked; it stays an explicit operator action
  outside PortOS.
- **Install & start** and **Start** never download model weights. They read
  `mtplx models --json` — a local directory listing, no network — and start the
  server on a checkpoint already in that cache, because `mtplx serve` otherwise
  defaults to one hard-coded repo id and exits 1 before binding when that
  particular repo was never pulled, even on a machine holding a different MTP
  model. A running server serving a different alias than the provider names is
  reported by the checklist's model check and left for you to resolve.
- The **Download the default model & start MTPLX** button is the one action
  here that fetches weights, and it appears only when that same cache listing
  proves there is nothing servable — an empty cache, or one holding only a
  half-finished `mtplx pull`. It runs `mtplx pull` with no repo id, so it can
  only ever fetch MTPLX's own default verified checkpoint; nothing from the
  page picks what is downloaded. It exists because the checklist otherwise
  offered a **Start MTPLX** that could only fail, and named the missing weights
  solely inside that failure — the one blocking fact was reachable only by
  clicking the button it made impossible.
- Closing the modal **cancels the download**. PortOS allows one local-runtime
  setup at a time, and a weights pull can run for hours, so leaving it running
  after you dismissed it would also refuse every other runtime's setup button
  for the rest of it. A cancelled pull leaves a partial download in the cache,
  which the checklist reports as such and offers to re-fetch.
- It only ever runs for an endpoint on **this** machine. A preset pointed at
  another host gets no checklist and no button — that install is whoever runs
  it.

All presets are disabled by default. Merely updating PortOS does not make a
network request, invoke a model, tune speculative decoding, alter the active
provider, or install anything — the setup above runs only from that explicit
click. MTPLX tuning remains an explicit operator action outside PortOS.

## Operational notes

- MTPLX can offer a faster path for an MTP-capable Qwen checkpoint; benchmark it
  on the target machine rather than assuming it improves the existing Ollama
  model.
- Keep the MTPLX endpoint local. The provided presets use a loopback address;
  if you intentionally change it, treat the server and model weights as a
  separate trusted runtime.
- The source audit that motivated this integration found privileged optional
  thermal-helper and installer paths upstream. Nothing here runs at PortOS
  setup or boot, and the one-click setup uses only the published package
  install plus `mtplx serve`, so those privileged paths never run as part of
  PortOS at all.

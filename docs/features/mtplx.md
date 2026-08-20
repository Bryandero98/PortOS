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
   then runs `mtplx serve --port <the port your provider points at>` and waits
   for `/v1/models` to answer. Progress streams into the install modal.
3. Use **Refresh Models** once the server is up; PortOS then reads `/v1/models`
   on demand. The seed model alias is `mtplx` — refresh it if your running
   server publishes a different one.
4. Choose **MTPLX (local MTP)** for supported non-coding tasks, or choose an
   **OpenCode MTPLX** CLI/TUI preset for a CoS coding task.

Prefer to run it yourself? Install MTPLX per its upstream documentation and
start a server on the loopback OpenAI-compatible endpoint the preset points at,
`http://127.0.0.1:8000/v1`. The checklist notices and collapses to a ready pill.

### What the button does and does not do

- It installs the MTPLX package and starts its **API server only**. Upstream's
  optional `mtplx max --install` fan-control helper — the one privileged path
  in that project — is never invoked; it stays an explicit operator action
  outside PortOS.
- It does **not** download model weights or choose a checkpoint. A running
  server serving a different alias than the provider names is reported by the
  checklist's model check and left for you to resolve.
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

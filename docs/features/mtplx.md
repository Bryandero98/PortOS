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

## Where it is managed

**Models → LLMs** is the home for MTPLX's lifecycle, alongside every other local
server PortOS can run:

- **Local Runtime Servers** — one table covering Ollama, LM Studio, llama.cpp
  and MTPLX, with the same Install / Start / Stop controls for each and a
  **Save PM2 list for reboot** action (see [Startup at boot](#startup-at-boot)).
- The **MTPLX** card below it picks *which* cached checkpoint and *which* port to
  serve on, and shows the server's recent log lines.

PortOS runs MTPLX as a **PM2 process named `portos-mtplx`**, exactly like
`portos-llama-server`. So `pm2 list` shows it next to the rest of the install,
`pm2 logs portos-mtplx` has its output, a PortOS restart re-adopts a server it
started earlier rather than losing track of it, and a reboot can bring it back.

The **AI Providers** readiness checklist keeps its one-click **Install & start
MTPLX** button. That button now drives the same manager, so a server started
from the checklist is the same managed process the LLMs page can stop and log.

## Setup

Two surfaces set MTPLX up, and they drive the same PM2 process — use whichever
you are already on.

**From Models → LLMs** (full control over the checkpoint and the port):

1. Install MTPLX from **Local Runtime Servers**. PortOS installs the package
   from upstream's Homebrew tap (`brew install youssofal/mtplx/mtplx`), falling
   back to `python3 -m pip install mtplx` on a host without Homebrew.
2. **Download a checkpoint** from the MTPLX card's **Cached checkpoints** /
   **Find a checkpoint** panel. Search runs `mtplx forge discover` — upstream's
   index of MTPLX-branded MTP models, which is exactly the set `mtplx serve` can
   run — and **Download** on a result runs `mtplx pull <repo>` with live byte
   progress. With an empty cache the panel leads with **Download default
   checkpoint**, MTPLX's own verified model. **Remove** on a cached row runs
   `mtplx remove` and reports the disk freed. Nothing here downloads on its own:
   `mtplx serve` exits before it binds a port on an empty cache, and the card
   refuses to start until something is cached — but the fix is a button, not a
   terminal.
3. **Start MTPLX** from the MTPLX card, choosing a cached checkpoint and the port
   your provider points at. PortOS runs `mtplx serve` under PM2. A cold MLX
   checkpoint takes a while to load: the request comes back as soon as the
   server survives its first seconds, and the card's status finishes the story
   once the endpoint answers.

**From AI Providers** (one click, MTPLX's own default checkpoint):

1. Enable the matching preset. Its card shows an MTPLX requirements checklist
   (installed / server responding / model available).
2. Click **Install & start MTPLX** on that checklist. PortOS runs the same
   install as above, then `mtplx serve --port <the port your provider points at>
   --model <a model already in your MTPLX cache>`, and waits for `/v1/models` to
   answer. Progress streams into the install modal.
3. **If no weights are cached**, the checklist says so on the "server
   responding" and "model available" rows — MTPLX's server exits before it
   binds a port with an empty cache — and the button becomes **Download the
   default model & start MTPLX**. That runs `mtplx pull` (MTPLX's own default
   verified checkpoint, a multi-gigabyte download) and then starts the server,
   with the download's progress streaming into the same modal. To use a
   different MTP checkpoint instead, search for and download it on the MTPLX
   card in Models → LLMs, then click **Start MTPLX**.

Then, either way:

4. Use **Refresh Models** on the provider once the server is up; PortOS reads
   `/v1/models` on demand. The seed model alias is `mtplx` — refresh it if your
   running server publishes a different one.
5. Choose **MTPLX (local MTP)** for supported non-coding tasks, or choose an
   **OpenCode MTPLX** CLI/TUI preset for a CoS coding task.

Prefer to run it yourself? Install MTPLX per its upstream documentation and
start a server on the loopback OpenAI-compatible endpoint the preset points at,
`http://127.0.0.1:8000/v1`. PortOS reports it as **Running (external)** and does
not offer to stop a process it did not start.

## What PortOS does and does not do

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
- **Two surfaces fetch weights, and both are buttons the user presses by name.**
  The AI Providers checklist's **Download the default model & start MTPLX**
  appears only when the cache listing proves there is nothing servable — an
  empty cache, or one holding only a half-finished pull — and runs `mtplx pull`
  with no repo id, so it can only ever fetch MTPLX's own default verified
  checkpoint; nothing on that page picks what is downloaded. The Models → LLMs
  card's checkpoint panel is the full-control counterpart: search, download a
  named repo id, remove one. Neither is ever reached implicitly by an Install or
  a Start.
- **The card never tells you to open a terminal.** It used to: an empty cache
  printed `mtplx pull` and left the user to go run it. PortOS installs the
  runtime, starts it, stops it, logs it, and persists it across a reboot — the
  one step in the middle being a shell command was the odd one out, and the PRD
  now forbids it outright (NR-9).
- A download started from the **LLMs card** keeps running if you navigate away —
  it is a server-side `mtplx pull` with progress on a socket, not work owned by
  the page. Only the AI Providers checklist's modal cancels on close, for the
  reason below.
- Closing the checklist modal **cancels the download**. PortOS allows one local-runtime
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

## Startup at boot

`portos-mtplx` and `portos-llama-server` come back after a reboot the same way
every other PortOS process does — through PM2's saved dump:

1. Run `pm2 startup` **once** in a terminal and follow the privileged command it
   prints. PortOS deliberately never runs this: it writes a launchd/systemd unit
   and is blocked in PortOS's PM2 command guard.
2. With the servers you want running, click **Save PM2 list for reboot** on
   Models → LLMs (a plain `pm2 save`). Each PM2-managed runtime then shows a
   **starts at boot** pill.

Ollama and LM Studio are not PM2 processes — they manage their own
launch-at-login (Ollama through its service manager, via the **Run at login**
control on the same card; LM Studio through its app).

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

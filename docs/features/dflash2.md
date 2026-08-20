# Speculative Decoding (DSpark / DFlash 2) — llama.cpp & OpenCode llama TUI

[DFlash 2](https://huggingface.co/z-lab) provides deep, ultra-fast block-level speculative drafting for large language models (such as Qwen 2.5, Qwen 3.8, and Muse-Glimmer). By pairing a small speculative drafter model (typically 1.5–3 GB) with a target foundation model (e.g. 27B–30B), DFlash 2 achieves 2.5–3× end-to-end token generation speedups without sacrificing output quality.

[DSpark](https://arxiv.org/html/2607.05147v1) (DeepSeek) is the sibling drafter family — same lossless block-drafting idea, a rank-256 Markov head instead of DFlash 2's candidate selector, and a much wider set of published drafters.

PortOS integrates both through the **OpenCode llama TUI** provider preset and the managed local `llama-server`.

> **Which one to run:** `--spec-type draft-dspark` **merged into llama.cpp on 2026-07-28** ([#25173](https://github.com/ggml-org/llama.cpp/pull/25173)) and works on a stock `brew install llama.cpp`. DFlash 2's engine modules are **still an open PR** ([#27342](https://github.com/ggml-org/llama.cpp/pull/27342)) and need a from-source build of that branch. llama.cpp falls back **silently** on a spec-type/drafter mismatch rather than erroring, so a DFlash 2 drafter on a stock build degrades quietly. Start with DSpark unless you have built the DFlash 2 branch. Full comparison: [DSpark vs DFlash 2](../research/2026-08-19-dspark-vs-dflash2.md).

---

## What PortOS Adds

1. **OpenCode llama TUI Provider**:
   - An attachable `tui` coding-agent provider preset (`opencode-llama-tui`) configured to connect to `http://127.0.0.1:8080/v1`.
   - Seeded with default model aliases `["dflash", "qwen3.8-27b-dflash2", "Muse-Glimmer-30B-DFlash2"]` with default `dflash`. The launcher keeps `--alias dflash` for every drafter family so this alias resolves regardless of which one you run.
   - Fully enabled by default and equipped with OpenCode's agentic file-writing harness, tool calling, and session persistence.
2. **Model Refresh**:
   - Support for dynamic model discovery via the **Refresh Models** button on AI Providers, querying the local `llama-server` `/v1/models` endpoint.
3. **Local LLMs & AI Providers Guidance**:
   - UI instructions, command templates, and copyable run lines surfaced in **Settings → Local LLMs** and **AI Providers**.

---

## Setup & Running with llama-server

### 1. Download Base & Draft Models
Download your base GGUF and a matching drafter GGUF from Hugging Face. Drafter
checkpoints are **not standalone models** — they only produce text once an engine
pairs them with their specific target, which is why PortOS's model search filters
them out of the install picker.

DSpark pairs (stock llama.cpp):

- **Qwen 3.8 27B**: base `Qwen/Qwen3.8-27B-Instruct-GGUF` + drafter `DimInfer/Qwen3.8-27B-Dspark-v1`
- **Qwen 3 8B**: base `Qwen/Qwen3-8B-Instruct-GGUF` + drafter converted from `deepseek-ai/dspark_qwen3_8b_block7`

DSpark drafters ship without tokenizers — converting one to GGUF requires passing
`--target-model-dir` so it reuses the target's tokenizer. Keep the drafter at bf16;
the target can be any quant.

DFlash 2 pairs (require a source build of llama.cpp [#27342](https://github.com/ggml-org/llama.cpp/pull/27342)):

- **Qwen 3.8 27B Draft Pair**:
  - Base: `Qwen/Qwen3.8-27B-Instruct-GGUF` (e.g. `Qwen3.8-27B-Instruct-Q4_K_M.gguf`)
  - Drafter: `incoai/Qwen3.8-27B-DFlash2-GGUF` (e.g. `Qwen3.8-27B-DFlash2-Q4_K_M.gguf`)
- **Muse-Glimmer 30B Draft Pair**:
  - Base: `meta-models/Muse-Glimmer-30B-GGUF`
  - Drafter: `z-lab/Muse-Glimmer-30B-DFlash2-GGUF`

### 2. Launch llama-server
Start `llama-server` on loopback port `8080` with speculative decoding enabled
(`--spec-type draft-dflash` for a DFlash drafter, `draft-dspark` for a DSpark one):

```bash
llama-server \
  -m models/Qwen3.8-27B-Instruct-Q4_K_M.gguf \
  --draft-model models/Qwen3.8-27B-DSpark-bf16.gguf \
  --spec-type draft-dspark \
  --port 8080 \
  --host 127.0.0.1 \
  --alias dflash \
  --ctx-size 32768 \
  --n-gpu-layers 99
```

### 3. Use in PortOS
1. Navigate to **AI Providers** (`/ai`) or **Settings → Local LLMs**.
2. Verify **OpenCode llama TUI** is enabled.
3. Click **Refresh Models** to pull the live aliases from `llama-server`, or use the default `dflash` model.
4. Select **OpenCode llama TUI** in the CoS task creator or terminal runner to execute coding and agent tasks with speculative acceleration.

### Checking the requirements from the Providers page

Every provider backed by a local daemon carries a **requirements checklist** on
its card in **AI Providers** — fed by `GET /api/providers/readiness`, re-polled
every 20s:

1. **llama.cpp installed** — `llama-server` is on PortOS's PATH (or something is
   already answering at the endpoint, which proves it another way).
2. **llama.cpp server responding** — the endpoint THIS provider points at (its
   own `OPENCODE_CONFIG_CONTENT` `baseURL`, not a hardcoded default) answers
   `GET /v1/models`.
3. **Model available** — the provider's default model is one that endpoint
   actually serves. This is the alias check: `--alias dflash` with a provider
   asking for `dspark` fails here rather than inside a dead agent run.

Until all three pass, the card says what is missing and links to
**Settings → Local LLM**. The same failure previously surfaced only as
`Cannot connect to API: Unable to connect` inside the agent transcript.

The GGUF weights are a separate download from the binary: `llama-server` will
not start without them, and PortOS now refuses the start with the missing path
named rather than reporting a PID for a process that already exited.

---

## Ollama

Ollama's vendored llama.cpp engine has carried DSpark since **0.32.6**
([#17545](https://github.com/ollama/ollama/pull/17545)), but Ollama surfaces no
control for it — its server hardcodes `--spec-type draft-mtp` whenever
speculative decoding is on. Selecting DSpark requires overriding
`LLAMA_ARG_SPEC_TYPE` / `LLAMA_ARG_SPEC_DRAFT_MODEL` on the Ollama process and
pointing at a raw blob-store path; the one reported measurement through that
path was ~13%, far below what the drafter delivers natively. Tracked upstream in
[ollama#17016](https://github.com/ollama/ollama/issues/17016). **Use
`llama-server` for speculative decoding in PortOS, not the Ollama backend.**

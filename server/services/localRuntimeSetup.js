/**
 * One-click "make this local runtime work" for the provider readiness checklist.
 *
 * `providerReadiness.js` answers WHAT is missing (the daemon isn't installed,
 * isn't running, isn't serving the right model). Until this module existed, the
 * answer to "so fix it" was a link — to the Models → LLMs page for the two
 * backends PortOS manages, and to the vendor's README for MTPLX, which is a
 * dead end inside PortOS: the user leaves the app, reads a setup doc, runs two
 * commands in a terminal, comes back and reloads. This module makes the
 * checklist actionable in place: install the daemon, start it, and confirm the
 * endpoint answers — from the button next to the failing check.
 *
 * Every command here comes from the fixed table below. A request names a
 * runtime *kind* (`mtplx` / `llama` / `ollama` / `lmstudio` / `vllm`) and nothing else —
 * no package, URL, port, or argument from the request ever reaches a shell
 * word, which keeps this as narrow as `providerRuntimeInstaller.js`'s CLI
 * install surface while removing the docs dead end.
 *
 * Three deliberate limits, because guessing here would be worse than a link:
 *
 *   - **Weights are never downloaded behind a start.** llama.cpp cannot be
 *     started without a GGUF path the user chooses, and no runtime's *model*
 *     check is auto-fixed by a start — a multi-gigabyte download is a decision,
 *     and the Models → LLMs page already owns that flow with a picker. `start`
 *     runs MTPLX on a checkpoint ALREADY in its cache (`lib/mtplxModels.js`).
 *     A cache that is empty (or holds only a half-finished pull) is a SEPARATE
 *     action the user clicks by name — `pull-start`, "Download the default
 *     model & start MTPLX" — never something a Start button does silently.
 *     Before that action existed the checklist offered only Start, which then
 *     failed with "no model weights are cached": the one fact that mattered was
 *     reachable only by clicking the button it made impossible.
 *   - **MTPLX's privileged paths are never touched.** Upstream ships an
 *     optional `mtplx max --install` fan-control helper behind a sudo prompt.
 *     PortOS installs the package and starts the loopback API server; that
 *     helper stays an explicit operator action outside PortOS, exactly as
 *     `docs/features/mtplx.md` promised before this button existed.
 *   - **The vLLM container is never provisioned.** Its start row brings up an
 *     already-prepared compose project and nothing else: no image pull, no
 *     weight download, no docker/WSL2/NVIDIA-toolkit install. A project that is
 *     not demonstrably prepared is refused with the command that prepares it.
 */

import { IS_WIN32 } from '../lib/bufferedSpawn.js';
import { spawn } from '../lib/childProcess.js';
import { commandExists } from '../lib/commandExists.js';
import { sleep } from '../lib/fileUtils.js';
import { LOCAL_RUNTIMES, localEndpointPort } from '../lib/localProviderRuntime.js';
import { describeMtplxCache, listMtplxCachedModels } from '../lib/mtplxModels.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { inspectVllmQwenProject, vllmStartBlockedReason } from '../lib/vllmQwenProject.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { createLineReader, createOutputTail } from '../lib/streamLines.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { installLlamaServer } from './llamaServerManager.js';
import { controlOllamaServer, installBackend } from './localLlm.js';
import { isAppInstalled as isLmStudioAppInstalled } from './lmStudioManager.js';

/** Package-manager installs routinely run for minutes (a cask is a download). */
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

/** A short command that only asks a running daemon to do something. */
const CONTROL_TIMEOUT_MS = 60 * 1000;

/**
 * A model pull moves tens of gigabytes. Sized for a slow domestic line rather
 * than for a fast one — a bound that kills a download at 90% is worse than no
 * bound at all, and the user can close the modal to stop watching at any point.
 */
const WEIGHTS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Split a downloader's output on bare `\r` too, so a tqdm-style progress bar
 * that redraws one line surfaces each redraw instead of buffering silently for
 * the length of the download (`lib/streamLines.js`).
 */
const PROGRESS_SPLIT_RE = /[\r\n]+/;

/**
 * How long to wait for a just-started daemon to answer `/v1/models`. MTPLX
 * loads a multi-gigabyte MLX checkpoint before it binds, so this is sized for a
 * cold model load rather than for a socket coming up.
 */
/**
 * Parked on a detached daemon's `error` once this module stops watching it. An
 * EventEmitter `error` with NO listener throws, which outside the request
 * lifecycle takes the PortOS process down — so the watchers are replaced, never
 * merely removed. Module-scope, so it closes over nothing.
 */
const IGNORE_ERROR = () => {};

const START_TIMEOUT_MS = 3 * 60 * 1000;
const START_POLL_MS = 1_500;

/**
 * Bound on the `GET /v1/models` reachability probes. Loopback answers (or
 * refuses) in single-digit milliseconds; the wider bound is for the FINAL
 * confirmation, where a daemon that just finished loading a model can be slow
 * to answer its first request and reporting it as down would be wrong.
 */
const PROBE_TIMEOUT_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Why an installed MTPLX still cannot be started. Weights stay the user's
 * decision (`docs/features/mtplx.md`), so a plain Start never fetches them —
 * it names the button that does, plus the terminal command for a checkpoint
 * other than MTPLX's own default.
 */
const MTPLX_NO_MODEL_ERROR = 'no model weights are cached, so its server exits before it binds a port. Close this window — the checklist now offers “Download the default model & start MTPLX”, which fetches MTPLX\'s own verified checkpoint (a multi-gigabyte download) and then starts the server. To use a different MTP checkpoint instead, run `mtplx pull <hf-repo-id>` in a terminal, then click Start MTPLX again.';

/** The same dead end, reached from a cache holding only interrupted pulls. */
const mtplxPartialCacheError = (count) =>
  `its cache holds ${count} model${count === 1 ? '' : 's'}, but none passed its own file check — an interrupted \`mtplx pull\` leaves a partial download behind. Use “Download the default model & start MTPLX” on the checklist to re-fetch it, or run \`mtplx pull <hf-repo-id>\` in a terminal for another checkpoint.`;

/** What each `action` is called on the button and in the log. */
const ACTION_LABELS = {
  install: (label) => `Install ${label}`,
  start: (label) => `Start ${label}`,
  'install-start': (label) => `Install & start ${label}`,
  // Names the download so the click IS the consent — the one action here that
  // spends bandwidth measured in gigabytes.
  'pull-start': (label) => `Download the default model & start ${label}`,
};

/** Every action `runLocalRuntimeSetup` accepts — route validation reads this. */
export const SETUP_ACTIONS = Object.freeze(Object.keys(ACTION_LABELS));

/**
 * Spawn a long-lived local daemon and wait until its OpenAI-compatible endpoint
 * answers. Detached (own process group) so PortOS restarting does not take the
 * daemon down with it, and `unref`'d so a running daemon never holds the PortOS
 * process open. Output is streamed only during the startup window — a daemon's
 * steady-state request log is not install progress.
 */
async function startDaemon({ command, args, endpoint, emit, isCancelled = () => false, timeoutMs = START_TIMEOUT_MS }) {
  const binary = findCommandOnPath(command);
  if (!binary) return { success: false, error: `\`${command}\` was not found on PortOS's PATH after the install. Restart PortOS so it picks up the new bin directory, then try again.` };

  emit(`Starting: ${command} ${args.join(' ')}`);
  const child = spawn(binary, args, safeChildProcessOptions({
    env: safeChildProcessEnv(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN32,
  }));

  let exited = null;
  // Recent output, so a daemon that dies before it binds reports what it
  // printed rather than only its exit code.
  const tail = createOutputTail();
  const onLine = (line) => {
    const text = line.trim();
    if (!text) return;
    tail.remember(text);
    emit(text);
  };
  // One reader per stream: a shared carry buffer splices a half-written stdout
  // line onto the next stderr chunk (see `lib/streamLines.js`).
  const stdoutReader = createLineReader(onLine);
  const stderrReader = createLineReader(onLine);
  const onStdout = stdoutReader.push;
  const onStderr = stderrReader.push;
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  // Outside the request lifecycle: an unhandled 'error' on a child is a process
  // crash, and the exit code is what turns "still waiting" into a real reason.
  const onError = (err) => { exited = `failed to start: ${err.message}`; };
  const onExit = (code, signal) => {
    if (exited === null) exited = `exited early (${signal || `code ${code}`})`;
  };
  child.on('error', onError);
  child.on('exit', onExit);
  /**
   * Detach from the daemon, which outlives this request.
   *
   * Keep DRAINING: a daemon whose stdout pipe fills up blocks on its next
   * write, and `resume()` on a listener-less stream discards what it reads.
   *
   * Drop EVERY listener, not just `onData`: they share one closure scope, so
   * any one of them left attached to a long-lived child pins that scope — and
   * `emit` in it — which holds the SSE response open for the daemon's whole
   * lifetime. `IGNORE_ERROR` takes the `error` slot back so a later crash
   * cannot throw on an emitter with no listener.
   */
  const stopStreaming = () => {
    child.stdout?.off('data', onStdout);
    child.stderr?.off('data', onStderr);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.resume();
    }
    child.off('error', onError);
    child.off('exit', onExit);
    child.on('error', IGNORE_ERROR);
    child.unref();
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(START_POLL_MS);
    // The daemon is deliberately left running when the user closes the modal —
    // it is the thing they asked for, and killing it would undo the setup. Only
    // the WAIT stops.
    if (isCancelled()) {
      stopStreaming();
      return { success: false, error: 'Cancelled while waiting for the server to come up.' };
    }
    const probe = await probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS });
    if (probe.reachable) {
      stopStreaming();
      return { success: true, models: probe.models };
    }
    if (exited) {
      // Flush FIRST: the reason a daemon dies is often its last line, and a
      // child that exited without a trailing newline leaves it in the carry.
      stdoutReader.flush();
      stderrReader.flush();
      stopStreaming();
      const detail = tail.text();
      return { success: false, error: `${command} ${exited}.${detail ? ` ${detail}` : ''}` };
    }
  }

  stopStreaming();
  return { success: false, error: `${endpoint} still did not answer after ${Math.round(timeoutMs / 1000)}s. The daemon may still be loading a model — reload this page shortly.` };
}

/**
 * One row per local runtime PortOS can set up on its own.
 *
 * `platforms` is the HARD gate (an empty/absent list means every platform).
 * `install` and `start` are async steps taking `({ emit, endpoint, isCancelled })`
 * and returning `{ success, error?, note? }`; `start: null` means PortOS cannot
 * start this runtime unattended and the checklist keeps its existing link.
 */
const SETUP_ROWS = Object.freeze({
  mtplx: Object.freeze({
    platforms: ['darwin'],
    unsupportedReason: 'MTPLX runs only on macOS with Apple Silicon.',
    async install({ emit }) {
      // Upstream's recommended path is its Homebrew tap; pip is the documented
      // fallback for a host without Homebrew. Both install the same `mtplx`
      // binary, and neither runs the optional privileged fan-control helper.
      if (await commandExists('brew', ['--version'])) {
        emit('Installing MTPLX via Homebrew (youssofal/mtplx/mtplx)…');
        return runStreamingCommand('brew', ['install', 'youssofal/mtplx/mtplx'], emit, { timeoutMs: INSTALL_TIMEOUT_MS });
      }
      if (await commandExists('python3', ['--version'])) {
        emit('Homebrew was not found — installing MTPLX with pip instead…');
        return runStreamingCommand('python3', ['-m', 'pip', 'install', '--upgrade', 'mtplx'], emit, { timeoutMs: INSTALL_TIMEOUT_MS });
      }
      return { success: false, error: 'Neither Homebrew nor python3 is available. Install Homebrew from https://brew.sh, then try again.' };
    },
    /**
     * What MTPLX's own cache holds, WITHOUT starting it — `mtplx models --json`
     * is a local directory listing. Sits next to the `pull` step it gates so
     * the two cannot drift, and `providerReadiness.js` reads it through
     * `readRuntimeWeights` to put the same fact on the checklist.
     */
    async weights() {
      return describeMtplxCache(await listMtplxCachedModels()).state;
    },
    /**
     * Fetch MTPLX's OWN default verified checkpoint — no repo id from the
     * request, so this cannot be pointed at an arbitrary download. Runs only
     * for the `pull-start` action, which the user clicks by its full name.
     */
    async pull({ emit, isCancelled }) {
      const binary = findCommandOnPath('mtplx');
      if (!binary) return { success: false, error: '`mtplx` was not found on PortOS\'s PATH. Restart PortOS so it picks up the new bin directory, then try again.' };
      emit('Downloading MTPLX\'s default verified checkpoint. This is a multi-gigabyte download and can take a long while — leave this window open to watch it.');
      // `mtplx pull` redraws one progress line with a bare `\r`; splitting on
      // newlines alone would leave the stream silent for the whole download.
      // `isCancelled` is load-bearing here, not decoration: this is the one
      // step that can run for HOURS, and the route holds its single-setup lock
      // until this promise settles. Without it, closing the modal leaves the
      // download running and every other runtime's setup button refused for the
      // rest of it.
      return runStreamingCommand(binary, ['pull'], emit, { timeoutMs: WEIGHTS_TIMEOUT_MS, splitRe: PROGRESS_SPLIT_RE, isCancelled });
    },
    async start({ emit, endpoint, isCancelled }) {
      // `mtplx serve` defaults `--model` to ONE hard-coded checkpoint and exits
      // 1 before binding when that repo is not in its cache — even on a machine
      // holding a different MTP model that would have served fine. Ask the
      // cache first and name what is actually there.
      const cache = describeMtplxCache(await listMtplxCachedModels());
      if (cache.state === 'unknown') {
        // The cache could not be READ — which is not "read, and empty". Fall
        // through to MTPLX's own default rather than blocking a start that may
        // well work.
        emit(`Could not read MTPLX's model cache (${cache.error}) — starting with its default model.`);
      }
      if (cache.state === 'empty') return { success: false, error: MTPLX_NO_MODEL_ERROR };
      if (cache.state === 'partial') return { success: false, error: mtplxPartialCacheError(cache.count) };
      if (cache.model) emit(`Serving the cached MTPLX model ${cache.model}.`);
      // The cache lookup is an awaited subprocess — the modal can close while it
      // runs, and the caller's cancellation check happened BEFORE it. Without
      // this, a cancelled setup still spawns a detached daemon nobody asked to
      // keep.
      if (isCancelled()) return { success: false, error: 'Cancelled before the server was started.' };
      // `mtplx start` is interactive (it prompts for a model); `serve` is the
      // API-only server, which is the half PortOS actually talks to. The daemon
      // must bind where the PROVIDER points — a user who moved MTPLX to 8010
      // would otherwise get a second server on 8000 that nothing talks to.
      const args = ['serve', '--port', localEndpointPort(endpoint) || '8000', ...(cache.model ? ['--model', cache.model] : [])];
      return startDaemon({ command: 'mtplx', args, endpoint, emit, isCancelled });
    },
  }),

  vllm: Object.freeze({
    // CUDA + Marlin + FlashInfer in a Linux container. On macOS there is no card
    // to give it, and DFlash 2 on Apple Silicon is unproven in this project —
    // the analogous local-daemon path there already ships as MTPLX / DSpark.
    platforms: ['linux', 'win32'],
    unsupportedReason: 'The vLLM Qwen3.8-27B stack needs an NVIDIA GPU (RTX 3090) and a Linux container runtime. On Apple Silicon use the MTPLX or llama.cpp DSpark presets instead.',
    async install() {
      // Deliberately never installs anything. Docker Desktop / the NVIDIA
      // container toolkit / WSL2 are host-level operator decisions with driver
      // requirements PortOS cannot judge, and the payload is a ~9.5 GB image.
      return {
        success: false,
        error: 'PortOS does not install this stack. On the RTX 3090 host, set up WSL2 (or Linux) with Docker and the NVIDIA Container Toolkit, then follow docs/features/qwen38-rtx3090.md to clone and prepare syv-ai/qwen38-27b-rtx3090.',
      };
    },
    async start({ emit, isCancelled }) {
      // Only ever brings up an ALREADY-prepared project — see
      // `lib/vllmQwenProject.js` for why each refusal below exists.
      const project = await inspectVllmQwenProject();
      const blocked = vllmStartBlockedReason(project);
      if (blocked) return { success: false, error: blocked };
      if (isCancelled()) return { success: false, error: 'Cancelled before the container was started.' };
      emit(`Starting the vLLM container from ${project.dir} (${project.composeFile}).`);
      emit('The image and weights are already on disk — this only brings the service up.');
      return runStreamingCommand(
        'docker',
        ['compose', '--profile', 'single', 'up', '-d'],
        emit,
        { timeoutMs: CONTROL_TIMEOUT_MS, cwd: project.dir },
      );
    },
  }),

  ollama: Object.freeze({
    async install({ emit }) {
      // `installBackend` already registers the Homebrew service / runs the
      // vendor script on Linux and starts the daemon afterwards, so it covers
      // both steps for this runtime.
      const result = await installBackend('ollama', (p) => { if (p?.message) emit(p.message); });
      return result.success ? { success: true, note: result.note } : result;
    },
    async start({ emit }) {
      emit('Starting the Ollama server…');
      const result = await controlOllamaServer('start');
      return result?.success ? { success: true } : { success: false, error: result?.error || 'Ollama did not start.' };
    },
  }),

  lmstudio: Object.freeze({
    async install({ emit }) {
      const result = await installBackend('lmstudio', (p) => { if (p?.message) emit(p.message); });
      return result.success ? { success: true, note: result.note } : result;
    },
    async start({ emit }) {
      // `lms` is LM Studio's own CLI shim, installed by `lms bootstrap` from the
      // app. Without it there is no headless way to start the server, and
      // pretending otherwise would report a success the user cannot see.
      if (!findCommandOnPath('lms')) {
        return { success: false, error: 'LM Studio\'s `lms` CLI is not on PortOS\'s PATH. Open LM Studio once and run `lms bootstrap`, or start its local server from the app\'s Developer tab.' };
      }
      emit('Starting the LM Studio local server…');
      return runStreamingCommand('lms', ['server', 'start'], emit, { timeoutMs: CONTROL_TIMEOUT_MS });
    },
  }),

  llama: Object.freeze({
    async install({ emit }) {
      const result = await installLlamaServer({ onProgress: (p) => { if (p?.message) emit(p.message); } })
        .catch((err) => ({ success: false, error: err.message }));
      return result.success
        ? { success: true, note: 'Choose a GGUF model on Models → LLMs to start llama-server — PortOS does not pick weights for you.' }
        : result;
    },
    // llama-server takes a required model path, and the weights are a separate
    // multi-gigabyte download. Starting it unattended would mean guessing which
    // checkpoint the user meant, so the Models → LLMs page keeps that step.
    start: null,
  }),
});

/**
 * What a runtime's own model cache holds, without starting it. `'unknown'` for
 * every runtime with no cache PortOS can read offline — never `'empty'`, which
 * would claim a fact PortOS does not have.
 *
 * Exported so `providerReadiness.js` reports the checklist from the SAME fact
 * `describeRuntimeSetup` picks a button from; a second copy of the reader table
 * over there is how the two would drift into disagreeing about one cache.
 *
 * @returns {Promise<'unknown'|'empty'|'partial'|'ready'>}
 */
export async function readRuntimeWeights(kind) {
  const read = SETUP_ROWS[kind]?.weights;
  return read ? read() : 'unknown';
}

/** The cache states that make a start impossible. */
export const weightsBlockStart = (weights) => weights === 'empty' || weights === 'partial';

/** True when this host can run the runtime's setup at all. */
function platformSupported(row) {
  return !row.platforms || row.platforms.includes(process.platform);
}

/**
 * What (if anything) a "set this up for me" button should offer for one
 * runtime, given what its readiness checks found. Pure — the client renders it
 * straight from the readiness payload, so it must not probe anything.
 *
 * Returns `null` when there is nothing to offer: an unknown runtime, a platform
 * that cannot run it, a runtime already installed and running (the remaining
 * unmet check is the model, which PortOS will not choose), or a runtime PortOS
 * can install but not start when the install is already done.
 *
 * `weights` is what the caller already learned about the runtime's local model
 * cache (`lib/mtplxModels.js`'s `describeMtplxCache`), and only `'empty'` /
 * `'partial'` change the answer: those are the states where a Start CANNOT
 * work, so the button becomes the download that makes it possible instead of
 * the start that is guaranteed to fail. `'unknown'` — the default, and what
 * every runtime with no cache to read reports — deliberately keeps the old
 * behavior; a cache PortOS could not read must not be treated as an empty one.
 *
 * @param {string} kind - `mtplx` | `llama` | `ollama` | `lmstudio` | `vllm`
 * @param {{installed: boolean, running: boolean, weights?: 'unknown'|'empty'|'partial'|'ready'}} state
 */
export function describeRuntimeSetup(kind, { installed, running, weights = 'unknown' }) {
  const row = SETUP_ROWS[kind];
  const runtime = LOCAL_RUNTIMES[kind];
  if (!row || !runtime) return null;

  const needsInstall = !installed;
  const needsStart = !running && Boolean(row.start);
  if (!needsInstall && !needsStart) return null;

  if (!platformSupported(row)) {
    return { runtime: kind, label: runtime.label, action: null, actionLabel: null, blockedReason: row.unsupportedReason };
  }

  // Only offered once the binary is here: the cache cannot be read without it,
  // so an uninstalled runtime's `weights` says nothing and `install-start`
  // stays the honest first step.
  const needsWeights = Boolean(row.pull) && !needsInstall && needsStart && weightsBlockStart(weights);
  const action = needsWeights ? 'pull-start'
    : needsInstall && needsStart ? 'install-start'
      : needsInstall ? 'install' : 'start';
  return {
    runtime: kind,
    label: runtime.label,
    action,
    actionLabel: ACTION_LABELS[action](runtime.label),
    blockedReason: null,
  };
}

/**
 * Install and/or start one local runtime, reporting progress line by line.
 *
 * Re-probes the endpoint first: the user may have started the daemon in a
 * terminal since the page last polled, and re-running an install over a working
 * setup is the one outcome a "fix it" button must not produce.
 *
 * Never throws — the caller is an SSE route whose headers are already flushed,
 * so a failure has to come back as a value it can turn into a terminal frame.
 *
 * @param {string} kind
 * @param {{endpoint: string, emit: (line: string) => void, isCancelled?: () => boolean, action?: string}} ctx
 *   `isCancelled` is checked between steps so a closed modal does not go on to
 *   start a daemon nobody is watching for. `action` is the one the checklist's
 *   button named; only `pull-start` adds a step (the model download), and it is
 *   opt-in precisely so no other action can spend gigabytes of bandwidth. Omit
 *   it (`null`) and this resolves the action the checklist would offer right
 *   now — see the resolution comment below.
 * @returns {Promise<{success: boolean, error?: string, message?: string}>}
 */
export async function runLocalRuntimeSetup(kind, { endpoint, emit = () => {}, isCancelled = () => false, action = null }) {
  const row = SETUP_ROWS[kind];
  const runtime = LOCAL_RUNTIMES[kind];
  if (!row || !runtime) return { success: false, error: `PortOS has no automatic setup for \`${String(kind)}\`.` };

  // The reachability probe comes BEFORE the platform gate on purpose: a daemon
  // that is already answering is running whatever this host's platform is, and
  // "MTPLX runs only on macOS" is a false report about a server the user can
  // see working. The gate is about what PortOS may INSTALL, not about what is
  // already up.
  const target = endpoint || runtime.defaultBaseUrl;
  const probe = await probeOpenAiModels(target, { timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.reachable) {
    return { success: true, message: `${runtime.label} is already running at ${target} — nothing to do.` };
  }
  if (!platformSupported(row)) return { success: false, error: row.unsupportedReason };

  // Refuse a step this runtime does not have BEFORE anything is installed. A
  // `pull-start` aimed at Ollama would otherwise run Ollama's install on its way
  // to being refused, and llama.cpp (`start: null`) would return the
  // install-succeeded message without ever refusing at all.
  if (action === 'pull-start' && !row.pull) {
    return { success: false, error: `PortOS cannot download model weights for ${runtime.label}.` };
  }

  // Same two signals `providerReadiness.js` uses: the binary on PATH, plus LM
  // Studio's macOS app bundle, which serves without ever putting `lms` there.
  const installed = Boolean(runtime.command && findCommandOnPath(runtime.command)) ||
    (kind === 'lmstudio' && isLmStudioAppInstalled());

  // A request that names NO action came from a client built before `pull-start`
  // existed — a stale `client/dist` (`pm2 restart` does not rebuild it) or a tab
  // open across an upgrade. That client still renders THIS server's
  // `setup.actionLabel`, so the user clicked a button reading “Download the
  // default model & start MTPLX”; defaulting to a plain start would answer that
  // click with the very "no model weights are cached" dead end this action
  // exists to remove. Resolve what the checklist is offering instead, which is
  // by construction the label they clicked.
  // `installed &&` mirrors `describeRuntimeSetup`'s own gate: the cache cannot
  // be read without the binary, so an uninstalled runtime never resolves to a
  // download — and never spends a cache read to learn that.
  const resolved = action || (row.pull && installed && weightsBlockStart(await row.weights()) ? 'pull-start' : 'install-start');

  if (!installed) {
    const result = await row.install({ emit, endpoint: target, isCancelled });
    if (!result.success) return { success: false, error: `${runtime.label} install failed: ${result.error}` };
    emit(`${runtime.label} is installed.`);
    if (result.note) emit(result.note);
  } else {
    emit(`${runtime.label} is already installed — starting it.`);
  }

  if (!row.start) {
    return { success: true, message: `${runtime.label} is installed. Pick a model on Models → LLMs to start it.` };
  }
  if (isCancelled()) return { success: false, error: 'Cancelled after the install — nothing was started.' };

  // The ONLY path that downloads weights, and it runs only because the user
  // clicked a button that says so. `describeRuntimeSetup` offers it exactly
  // when the cache is provably unusable, which is the state where a plain
  // Start would exit before binding a port.
  if (resolved === 'pull-start') {
    const pulled = await row.pull({ emit, isCancelled });
    if (!pulled.success) return { success: false, error: `${runtime.label} model download failed: ${pulled.error}` };
    emit(`${runtime.label}'s default checkpoint is cached.`);
    if (isCancelled()) return { success: false, error: 'Cancelled after the download — the weights are cached, but nothing was started.' };
  }

  // The install step may have started it (Ollama's Homebrew service does), so
  // re-probe rather than launching a second copy onto the same port.
  const afterInstall = await probeOpenAiModels(target, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!afterInstall.reachable) {
    const started = await row.start({ emit, endpoint: target, isCancelled });
    if (!started.success) return { success: false, error: `${runtime.label} did not start: ${started.error}` };
  }

  const final = await probeOpenAiModels(target, { timeoutMs: CONFIRM_TIMEOUT_MS });
  if (!final.reachable) {
    return { success: false, error: `${runtime.label} was set up, but ${target} still does not answer${final.error ? ` (${final.error})` : ''}.` };
  }
  const served = Array.isArray(final.models) && final.models.length > 0
    ? ` It is serving ${final.models.slice(0, 3).join(', ')}${final.models.length > 3 ? ` +${final.models.length - 3} more` : ''}.`
    : '';
  return { success: true, message: `${runtime.label} is running at ${target}.${served}` };
}

/** The runtime kinds this module can set up — used by route validation and tests. */
export const SETUP_RUNTIME_KINDS = Object.freeze(Object.keys(SETUP_ROWS));

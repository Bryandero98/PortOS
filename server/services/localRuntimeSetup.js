/**
 * One-click "make this local runtime work" for the provider readiness checklist.
 *
 * `providerReadiness.js` answers WHAT is missing (the daemon isn't installed,
 * isn't running, isn't serving the right model). Until this module existed, the
 * answer to "so fix it" was a link — to the Local LLM settings tab for the two
 * backends PortOS manages, and to the vendor's README for MTPLX, which is a
 * dead end inside PortOS: the user leaves the app, reads a setup doc, runs two
 * commands in a terminal, comes back and reloads. This module makes the
 * checklist actionable in place: install the daemon, start it, and confirm the
 * endpoint answers — from the button next to the failing check.
 *
 * Every command here comes from the fixed table below. A request names a
 * runtime *kind* (`mtplx` / `llama` / `ollama` / `lmstudio`) and nothing else —
 * no package, URL, port, or argument from the request ever reaches a shell
 * word, which keeps this as narrow as `providerRuntimeInstaller.js`'s CLI
 * install surface while removing the docs dead end.
 *
 * Two deliberate limits, because guessing here would be worse than a link:
 *
 *   - **Weights are never downloaded.** llama.cpp cannot be started without a
 *     GGUF path the user chooses, and no runtime's *model* check is auto-fixed
 *     — a multi-gigabyte download is a decision, and the Local LLM tab already
 *     owns that flow with a picker.
 *   - **MTPLX's privileged paths are never touched.** Upstream ships an
 *     optional `mtplx max --install` fan-control helper behind a sudo prompt.
 *     PortOS installs the package and starts the loopback API server; that
 *     helper stays an explicit operator action outside PortOS, exactly as
 *     `docs/features/mtplx.md` promised before this button existed.
 */

import { IS_WIN32 } from '../lib/bufferedSpawn.js';
import { spawn } from '../lib/childProcess.js';
import { commandExists } from '../lib/commandExists.js';
import { sleep } from '../lib/fileUtils.js';
import { LOCAL_RUNTIMES, localEndpointPort } from '../lib/localProviderRuntime.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { installLlamaServer } from './llamaServerManager.js';
import { controlOllamaServer, installBackend } from './localLlm.js';
import { isAppInstalled as isLmStudioAppInstalled } from './lmStudioManager.js';

/** Package-manager installs routinely run for minutes (a cask is a download). */
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

/** A short command that only asks a running daemon to do something. */
const CONTROL_TIMEOUT_MS = 60 * 1000;

/**
 * How long to wait for a just-started daemon to answer `/v1/models`. MTPLX
 * loads a multi-gigabyte MLX checkpoint before it binds, so this is sized for a
 * cold model load rather than for a socket coming up.
 */
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

/** What each `action` is called on the button and in the log. */
const ACTION_LABELS = {
  install: (label) => `Install ${label}`,
  start: (label) => `Start ${label}`,
  'install-start': (label) => `Install & start ${label}`,
};

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
  const onData = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      const text = line.trim();
      if (text) emit(text);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  /**
   * Stop forwarding, but keep DRAINING: a daemon whose stdout pipe fills up
   * blocks on its next write, and `resume()` on a listener-less stream discards
   * what it reads. Dropping the listener also releases `emit`'s closure over the
   * SSE response, which would otherwise be retained for the daemon's lifetime.
   */
  const stopStreaming = () => {
    for (const stream of [child.stdout, child.stderr]) {
      stream?.off('data', onData);
      stream?.resume();
    }
    child.unref();
  };
  // Outside the request lifecycle: an unhandled 'error' on a child is a process
  // crash, and the exit code is what turns "still waiting" into a real reason.
  child.on('error', (err) => { exited = `failed to start: ${err.message}`; });
  child.on('exit', (code, signal) => {
    if (exited === null) exited = `exited early (${signal || `code ${code}`})`;
  });

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
      stopStreaming();
      return { success: false, error: `${command} ${exited}.` };
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
    start({ emit, endpoint, isCancelled }) {
      // `mtplx start` is interactive (it prompts for a model); `serve` is the
      // API-only server, which is the half PortOS actually talks to. The daemon
      // must bind where the PROVIDER points — a user who moved MTPLX to 8010
      // would otherwise get a second server on 8000 that nothing talks to.
      return startDaemon({ command: 'mtplx', args: ['serve', '--port', localEndpointPort(endpoint) || '8000'], endpoint, emit, isCancelled });
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
        ? { success: true, note: 'Choose a GGUF model on Settings → Local LLM to start llama-server — PortOS does not pick weights for you.' }
        : result;
    },
    // llama-server takes a required model path, and the weights are a separate
    // multi-gigabyte download. Starting it unattended would mean guessing which
    // checkpoint the user meant, so the Local LLM tab keeps that step.
    start: null,
  }),
});

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
 * @param {string} kind - `mtplx` | `llama` | `ollama` | `lmstudio`
 * @param {{installed: boolean, running: boolean}} state
 */
export function describeRuntimeSetup(kind, { installed, running }) {
  const row = SETUP_ROWS[kind];
  const runtime = LOCAL_RUNTIMES[kind];
  if (!row || !runtime) return null;

  const needsInstall = !installed;
  const needsStart = !running && Boolean(row.start);
  if (!needsInstall && !needsStart) return null;

  if (!platformSupported(row)) {
    return { runtime: kind, label: runtime.label, action: null, actionLabel: null, blockedReason: row.unsupportedReason };
  }

  const action = needsInstall && needsStart ? 'install-start' : needsInstall ? 'install' : 'start';
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
 * @param {{endpoint: string, emit: (line: string) => void, isCancelled?: () => boolean}} ctx
 *   `isCancelled` is checked between steps so a closed modal does not go on to
 *   start a daemon nobody is watching for.
 * @returns {Promise<{success: boolean, error?: string, message?: string}>}
 */
export async function runLocalRuntimeSetup(kind, { endpoint, emit = () => {}, isCancelled = () => false }) {
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

  // Same two signals `providerReadiness.js` uses: the binary on PATH, plus LM
  // Studio's macOS app bundle, which serves without ever putting `lms` there.
  const installed = Boolean(runtime.command && findCommandOnPath(runtime.command)) ||
    (kind === 'lmstudio' && isLmStudioAppInstalled());

  if (!installed) {
    const result = await row.install({ emit, endpoint: target, isCancelled });
    if (!result.success) return { success: false, error: `${runtime.label} install failed: ${result.error}` };
    emit(`${runtime.label} is installed.`);
    if (result.note) emit(result.note);
  } else {
    emit(`${runtime.label} is already installed — starting it.`);
  }

  if (!row.start) {
    return { success: true, message: `${runtime.label} is installed. Pick a model on Settings → Local LLM to start it.` };
  }
  if (isCancelled()) return { success: false, error: 'Cancelled after the install — nothing was started.' };

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

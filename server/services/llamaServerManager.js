/**
 * llama-server process manager
 *
 * Provides lifecycle management (status probe, start, stop, recent logs)
 * for a local `llama-server` instance running speculative decoding (e.g. DFlash 2)
 * managed as an optional PM2 process (`portos-llama-server`).
 */

import { stat } from 'fs/promises';
import { spawn } from '../lib/childProcess.js';
import { commandExists } from '../lib/commandExists.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { expandHome, sleep } from '../lib/fileUtils.js';
import { createDaemonLogBuffer, pm2ArgValue } from '../lib/managedDaemon.js';
import { resolveSpecModelPath } from './specDecodeModels.js';
import { parseSpecTypes, isDraftSpecType } from '../lib/specDecodePresets.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { isPortInUse } from '../lib/platform.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { execPm2, getAppStatusStrict, clearJlistCache, getSavedProcessNames } from './pm2.js';

export const LLAMA_APP = 'portos-llama-server';

const PROBE_TIMEOUT_MS = 1500;
const STARTUP_WAIT_TIMEOUT_MS = 4000;
// How long a relaunch waits for the kernel to release the old listener.
const PORT_RELEASE_TIMEOUT_MS = 5000;
// How long a relaunch waits for the new process to answer. `startLlamaServer`
// polls for only STARTUP_WAIT_TIMEOUT_MS, which a large GGUF routinely exceeds
// while loading — so a relaunch must not read "not ready yet" as "wedged".
// Mutable only through the test seam below: a suite asserting the give-up path
// cannot sit through two real minutes of polling.
let relaunchReadyTimeoutMs = 120000;

let currentConfig = null;
let lastExitError = null;
const logs = createDaemonLogBuffer();
const appendLog = logs.append;

/**
 * Probes whether an OpenAI-compatible endpoint responds at the given host/port.
 * Shares one implementation with the readiness checklist.
 */
const probeEndpoint = async (endpoint) =>
  (await probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS })).reachable;

/**
 * Resolves the `llama-server` executable on the child-process PATH.
 *
 * Deliberately a filesystem probe only — `findCommandOnPath` already requires a
 * regular file carrying the execute bit, which is all "is it installed?" means.
 * Do NOT re-add a `commandExists`-style `llama-server --version` probe on top.
 *
 * @returns {string|null} absolute path, or null when it is not on PATH
 */
function resolveLlamaServerBinary() {
  return findCommandOnPath('llama-server');
}

/**
 * Fails the start request when a GGUF the launch line names is not on disk.
 */
async function assertModelFileExists(label, modelPath) {
  const stats = await stat(resolveSpecModelPath(modelPath)).catch(() => null);
  if (stats?.isFile()) return;
  throw new ServerError(
    `${label} was not found at \`${modelPath}\`. Use the Download button next to this preset in the Speculative Decoding card to fetch it, or point this field at a file you already have.`,
    { status: 400, code: 'LLAMA_MODEL_FILE_MISSING' }
  );
}

/**
 * Reconstructs the launch config from PM2 process args if PortOS restarted
 * while the PM2 process remained online.
 */
function parseConfigFromArgs(args) {
  if (!args) return null;
  const list = Array.isArray(args) ? args : String(args).split(' ');
  const getArg = (flag) => pm2ArgValue(list, flag);

  const model = getArg('-m') || getArg('--model');
  if (!model) return null;

  const draftModel = getArg('--model-draft') || getArg('--spec-draft-model') || getArg('-md');
  // Absent means the process is running WITHOUT speculative decoding — don't
  // invent a type the launch line never carried.
  const specType = getArg('--spec-type');
  const port = getArg('--port') ? Number(getArg('--port')) : PORTS.LLAMA_SERVER;
  const host = getArg('--host') || '127.0.0.1';
  const ctxSize = getArg('--ctx-size') ? Number(getArg('--ctx-size')) : 32768;
  const nGpuLayers = getArg('-ngl') !== null ? Number(getArg('-ngl')) : 99;
  const alias = getArg('--alias') || 'dflash';

  return {
    model,
    draftModel,
    specType,
    port,
    host,
    ctxSize,
    nGpuLayers,
    alias,
    // Tuning flags. `null` means the flag was NOT on the launch line, so
    // llama.cpp's own default applied — distinct from a value we chose. A
    // caller re-launching with this config must leave a null off the line
    // rather than substituting a number llama.cpp never saw.
    batchSize: getArg('-b') !== null ? Number(getArg('-b')) : null,
    ubatchSize: getArg('-ub') !== null ? Number(getArg('-ub')) : null,
    threads: getArg('-t') !== null ? Number(getArg('-t')) : null,
    flashAttn: list.includes('--flash-attn') || list.includes('-fa'),
    cacheTypeK: getArg('--cache-type-k'),
    cacheTypeV: getArg('--cache-type-v'),
    draftMax: getArg('--draft-max') !== null ? Number(getArg('--draft-max')) : null,
  };
}

// The endpoint the current (or last-known) configuration serves on. Split out so
// the two callers below can't drift on how host/port are defaulted.
const endpointFor = (config) =>
  `http://${config?.host || '127.0.0.1'}:${config?.port ?? PORTS.LLAMA_SERVER}/v1`;

/**
 * Just the base URL llama-server is serving on — no endpoint probe, no PM2 log
 * fetch.
 *
 * `getLlamaServerStatus` answers a much bigger question and pays for it with a
 * network probe AND an `execPm2 logs` subprocess. A caller that only needs
 * "which port is it on?" (the assessments read path, which runs on every
 * Performance page load) must not spawn a process to find out and then discard
 * the logs it paid for.
 *
 * Reads the same recovered-config path as the status call, so a PortOS restart
 * that left the PM2 process online still resolves the real port rather than the
 * default.
 */
export async function getLlamaServerEndpoint() {
  if (!currentConfig) {
    const pm2Status = await getAppStatusStrict(LLAMA_APP);
    if (pm2Status?.status === 'online' && pm2Status.args) {
      currentConfig = parseConfigFromArgs(pm2Status.args);
    }
  }
  return endpointFor(currentConfig);
}

/**
 * Returns current status of llama-server (binary availability, running state, config, logs).
 */
export async function getLlamaServerStatus() {
  const binaryPath = resolveLlamaServerBinary();
  const installed = Boolean(binaryPath);

  const [pm2Status, savedApps] = await Promise.all([getAppStatusStrict(LLAMA_APP), getSavedProcessNames()]);
  const isReadFailed = pm2Status === null;
  const isManagedActive = Boolean(pm2Status && pm2Status.status === 'online');

  if (!currentConfig && isManagedActive && pm2Status?.args) {
    currentConfig = parseConfigFromArgs(pm2Status.args);
  }

  const host = currentConfig?.host || '127.0.0.1';
  const port = currentConfig?.port ?? PORTS.LLAMA_SERVER;
  const endpoint = endpointFor(currentConfig);

  const reachable = await probeEndpoint(endpoint);

  const pm2Logs = isManagedActive || (pm2Status && pm2Status.status !== 'not_found')
    ? await execPm2(['logs', LLAMA_APP, '--nostream', '--lines', String(logs.maxLines)]).catch(() => null)
    : null;

  return {
    installed,
    running: isManagedActive || reachable,
    managed: isReadFailed ? null : isManagedActive,
    pid: isManagedActive ? (pm2Status?.pid || null) : null,
    host,
    port,
    endpoint,
    config: isManagedActive ? currentConfig : null,
    // Is this PM2 app in the saved dump `pm2 resurrect` replays at boot?
    // `null` = the dump could not be read, which is not the same as "no".
    runAtStartup: savedApps === null ? null : savedApps.includes(LLAMA_APP),
    recentLogs: logs.withPm2Logs(`${pm2Logs?.stdout || ''}\n${pm2Logs?.stderr || ''}`),
    lastExitError: isReadFailed ? 'Failed to read PM2 status' : lastExitError,
  };
}

/**
 * Starts llama-server with the specified model and options under PM2.
 */
export async function startLlamaServer(options = {}) {
  const binaryPath = resolveLlamaServerBinary();
  if (!binaryPath) {
    throw new ServerError(
      'llama-server binary was not found on PATH. Install it via Homebrew (`brew install llama.cpp`) or build from source.',
      { status: 400 }
    );
  }

  const pm2Status = await getAppStatusStrict(LLAMA_APP);
  if (pm2Status && pm2Status.status === 'online') {
    throw new ServerError(`llama-server is already running with PID ${pm2Status.pid}`, { status: 409 });
  }

  const {
    model,
    draftModel,
    specType = 'draft-dflash',
    port = PORTS.LLAMA_SERVER,
    host = '127.0.0.1',
    ctxSize = 32768,
    nGpuLayers = 99,
    alias = 'dflash',
    // Tuning knobs (`lib/localModelTuning.js`). Every one defaults to `null` =
    // NOT SET: the flag is left off the launch line entirely so llama.cpp
    // applies its own default. Substituting a number here would silently pin a
    // value the user never chose and make two "default" runs incomparable.
    batchSize = null,
    ubatchSize = null,
    threads = null,
    flashAttn = false,
    cacheTypeK = null,
    cacheTypeV = null,
    draftMax = null,
  } = options;

  if (!model || typeof model !== 'string') {
    throw new ServerError('model path is required to start llama-server', { status: 400 });
  }

  const endpoint = `http://${host}:${port}/v1`;
  const reachable = await probeEndpoint(endpoint);
  if (reachable) {
    throw new ServerError(`Port ${port} is already in use by an active server at ${endpoint}`, { status: 409 });
  }
  if (await isPortInUse(port)) {
    throw new ServerError(
      `Port ${port} is already in use on ${host}. Choose a different port under Advanced options before starting llama-server.`,
      { status: 409, code: 'LLAMA_SERVER_PORT_IN_USE' }
    );
  }

  // Validate the weights before building the launch line
  await assertModelFileExists('The base model', model.trim());
  const configuredDraftPath = typeof draftModel === 'string' && draftModel.trim()
    ? draftModel.trim()
    : null;

  // `--spec-type` is a comma-separated LIST, and only its `draft-*` entries want
  // a drafter GGUF — every `ngram-*` implementation speculates off the tokens
  // already in the context window. Emitting the flag only alongside a drafter
  // therefore threw away perfectly valid drafter-free launches
  // (`--spec-type ngram-map-k`) and silently ignored the ngram half of a mixed
  // one (`draft-dflash,ngram-map-k`).
  //
  // The two halves are resolved against each other, because the launcher card
  // seeds BOTH fields from a preset: switching Spec Type to an `ngram-*` leaves
  // the preset's drafter path sitting in the form, and passing that as
  // `--model-draft` would load weights the run can't use — or fail the
  // existence check below on a preset GGUF that was never downloaded. So a
  // drafter is only carried when some requested type actually drafts with one,
  // and drafter-based types are dropped (with a log line) when no drafter is
  // set, which keeps the card's documented "clear the field to run without it"
  // working. An EMPTY spec type deliberately still counts as wanting the
  // drafter: llama.cpp speculates off a bare `--model-draft`, so dropping it
  // there would silently disable a working configuration.
  const requestedSpecTypes = parseSpecTypes(specType);
  const drafterInUse = requestedSpecTypes.length === 0 || requestedSpecTypes.some(isDraftSpecType);
  const draftPath = drafterInUse ? configuredDraftPath : null;
  const effectiveSpecTypes = draftPath
    ? requestedSpecTypes
    : requestedSpecTypes.filter((type) => !isDraftSpecType(type));
  const droppedSpecTypes = requestedSpecTypes.filter((type) => !effectiveSpecTypes.includes(type));

  if (draftPath) await assertModelFileExists('The drafter model', draftPath);

  const args = ['-m', expandHome(model.trim())];
  if (draftPath) args.push('--model-draft', expandHome(draftPath));
  if (effectiveSpecTypes.length > 0) args.push('--spec-type', effectiveSpecTypes.join(','));
  if (port) args.push('--port', String(port));
  if (host) args.push('--host', host);
  if (ctxSize) args.push('--ctx-size', String(ctxSize));
  if (nGpuLayers !== undefined && nGpuLayers !== null) args.push('-ngl', String(nGpuLayers));
  if (Number.isFinite(batchSize)) args.push('-b', String(batchSize));
  if (Number.isFinite(ubatchSize)) args.push('-ub', String(ubatchSize));
  if (Number.isFinite(threads)) args.push('-t', String(threads));
  if (flashAttn) args.push('--flash-attn');
  if (cacheTypeK) args.push('--cache-type-k', String(cacheTypeK));
  if (cacheTypeV) args.push('--cache-type-v', String(cacheTypeV));
  // Only meaningful alongside a drafter — passing it without one makes
  // llama-server reject the launch line outright.
  if (Number.isFinite(draftMax) && draftPath) args.push('--draft-max', String(draftMax));
  if (alias) args.push('--alias', alias);

  lastExitError = null;
  logs.reset();
  if (droppedSpecTypes.length > 0) {
    appendLog(`Ignoring spec-type ${droppedSpecTypes.join(',')} — no drafter model is set`);
    console.log(`🦙 llama-server dropping drafter-based spec types ${droppedSpecTypes.join(',')} (no --model-draft configured)`);
  }
  if (configuredDraftPath && !draftPath) {
    appendLog(`Ignoring drafter ${configuredDraftPath} — no requested spec type uses one`);
    console.log(`🦙 llama-server ignoring drafter ${configuredDraftPath} (spec types ${effectiveSpecTypes.join(',') || 'none'} need no drafter)`);
  }
  appendLog(`Starting: llama-server ${args.join(' ')}`);

  currentConfig = {
    model,
    // The drafter actually on the launch line, so the status card reports what
    // is running rather than what the form happened to be holding.
    draftModel: draftPath,
    // The types actually on the launch line, so the status card reports what is
    // running rather than what was asked for.
    specType: effectiveSpecTypes.join(','),
    port,
    host,
    ctxSize,
    nGpuLayers,
    alias,
    batchSize,
    ubatchSize,
    threads,
    flashAttn,
    cacheTypeK,
    cacheTypeV,
    draftMax,
  };

  // Delete stale PM2 entry so our own previous instance doesn't count as a collision
  await execPm2(['delete', LLAMA_APP]).catch(() => {});
  clearJlistCache();

  console.log(`🦙 llama-server starting on ${host}:${port} (model ${model}${draftPath ? `, drafter ${draftPath}` : ''})`);
  await execPm2([
    'start', binaryPath,
    '--name', LLAMA_APP,
    '--interpreter', 'none',
    '--no-autorestart',
    '--',
    ...args,
  ]);
  clearJlistCache();

  // Wait a short beat and verify probe
  const startTime = Date.now();
  let online = false;
  let currentProc = null;
  while (Date.now() - startTime < STARTUP_WAIT_TIMEOUT_MS) {
    await sleep(500);
    clearJlistCache();
    currentProc = await getAppStatusStrict(LLAMA_APP);
    if (currentProc && (currentProc.status === 'errored' || currentProc.status === 'stopped' || currentProc.status === 'not_found')) {
      break;
    }
    online = await probeEndpoint(endpoint);
    if (online) break;
  }

  if (currentProc && (currentProc.status === 'errored' || currentProc.status === 'stopped' || currentProc.status === 'not_found')) {
    const exitLogs = await execPm2(['logs', LLAMA_APP, '--nostream', '--lines', '15']).catch(() => null);
    const lines = (exitLogs?.stderr || exitLogs?.stdout || '').trim().split('\n').map((l) => l.trimEnd()).filter(Boolean);
    for (const line of lines) appendLog(line);
    const tail = (lines.length ? lines : logs.snapshot()).slice(-4).join(' | ');

    lastExitError = `PM2 status: ${currentProc.status}`;

    await execPm2(['delete', LLAMA_APP]).catch(() => {});
    clearJlistCache();
    throw new ServerError(
      `llama-server exited immediately${lastExitError ? ` (${lastExitError})` : ''}.${tail ? ` Last output: ${tail}` : ''}`,
      { status: 500, code: 'LLAMA_SERVER_EXITED' }
    );
  }

  const finalProc = await getAppStatusStrict(LLAMA_APP);

  return {
    success: true,
    running: true,
    managed: true,
    pid: finalProc?.pid || null,
    endpoint,
    online,
    config: currentConfig,
  };
}

/**
 * Stops the managed llama-server process.
 */
export async function stopLlamaServer() {
  const pm2Status = await getAppStatusStrict(LLAMA_APP);
  const isManaged = Boolean(pm2Status && pm2Status.status === 'online');

  if (!isManaged) {
    const host = currentConfig?.host || '127.0.0.1';
    const port = currentConfig?.port ?? PORTS.LLAMA_SERVER;
    const endpoint = `http://${host}:${port}/v1`;
    const reachable = await probeEndpoint(endpoint);
    if (reachable) {
      return {
        success: false,
        message: `An external process is listening on ${endpoint}. It was not started by PortOS and cannot be stopped here.`,
      };
    }
    return { success: true, message: 'llama-server is not running' };
  }

  appendLog(`Stopping ${LLAMA_APP}`);
  try {
    await execPm2(['delete', LLAMA_APP]);
    clearJlistCache();
  } catch (err) {
    throw new ServerError(`Failed to stop llama-server: ${err.message}`, { status: 500 });
  }
  currentConfig = null;

  return { success: true, message: 'llama-server stopped' };
}

/**
 * Block until nothing is listening on `port`, or the timeout elapses.
 *
 * `startLlamaServer` refuses when the port is still bound, and PM2's delete
 * returns before the kernel has released the listener — without this a relaunch
 * loses a race with itself and reports "port already in use" for the server it
 * just stopped.
 */
async function waitForPortRelease(port) {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline && await isPortInUse(port)) await sleep(200);
}

/**
 * Block until the endpoint answers, or the readiness budget elapses.
 * `false` means it never answered — which is a wedged process, not a slow one.
 */
async function waitForEndpoint(endpoint) {
  const deadline = Date.now() + relaunchReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeEndpoint(endpoint)) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * Relaunch llama-server with a different tuning, keeping the model/drafter it is
 * already serving.
 *
 * This is the "evaluate tuning parameters for launching these" half of the
 * measured-assessment feature: a sweep across micro-batch sizes or KV-cache
 * types is only possible if something can put those flags on the launch line
 * between runs.
 *
 * It refuses rather than guesses in the two cases where it cannot know what to
 * relaunch:
 *   - nothing is running, so there is no model path to reuse;
 *   - something IS listening but PortOS did not start it (an externally-launched
 *     llama-server), so stopping it would kill a process the user owns.
 *
 * Every one of those returns `{ applied: false, reason }` instead of throwing:
 * the caller (an assessment run) can still measure whatever is actually serving
 * and record that the requested tuning was NOT applied, which is far more useful
 * than failing the whole run. A launch line llama-server rejects, and a relaunch
 * that never answers on its port, land on the same shape — and the rejected case
 * puts the PREVIOUS configuration back, because a tuning sweep is expected to
 * produce launch lines that don't work and must not leave the daemon down.
 *
 * @param {object} tuning launch knobs from `lib/localModelTuning.js`
 * @returns {Promise<{applied: boolean, reason: string|null, config: object|null}>}
 */
export async function relaunchLlamaServerWithTuning(tuning = {}) {
  const knobs = Object.entries(tuning).filter(([, v]) => v !== null && v !== undefined);
  if (knobs.length === 0) {
    return { applied: false, reason: 'no launch knobs were requested', config: currentConfig };
  }

  const status = await getLlamaServerStatus();
  if (!status.running) {
    return { applied: false, reason: 'llama-server is not running, so PortOS has no model path to relaunch with', config: null };
  }
  if (!status.managed || !status.config?.model) {
    return {
      applied: false,
      reason: 'llama-server was started outside PortOS — start it from the LLMs page to let PortOS apply tuning',
      config: status.config || null,
    };
  }

  const previous = status.config;
  const next = { ...previous, ...tuning };
  console.log(`🦙 llama-server: relaunching to apply tuning (${knobs.map(([k, v]) => `${k}=${v}`).join(', ')})`);
  await stopLlamaServer();
  await waitForPortRelease(next.port ?? PORTS.LLAMA_SERVER);

  // A tuning sweep EXPECTS launch lines that don't work — `--flash-attn` on a
  // build without it, a `--cache-type-k` this build lacks, a `-ub` past what the
  // GPU can hold. llama-server exits immediately and `startLlamaServer` throws.
  // Leaving it down would be far worse than not applying the tuning: this daemon
  // fronts the `llama` provider for the whole install, so every later request
  // would fail too. Put the previous configuration back before reporting.
  const started = await startLlamaServer(next).catch(async (err) => {
    console.error(`❌ llama-server: tuning launch failed (${err.message}) — restoring the previous configuration`);
    await waitForPortRelease(previous.port ?? PORTS.LLAMA_SERVER);
    const restored = await startLlamaServer(previous).catch((restoreErr) => {
      console.error(`❌ llama-server: could not restore the previous configuration: ${restoreErr.message}`);
      return null;
    });
    return { failure: err.message, config: restored?.config || null };
  });
  if (started.failure) {
    return { applied: false, reason: `llama-server rejected that tuning: ${started.failure}`, config: started.config };
  }

  // PM2 reporting `online` is not the same as the server answering. But
  // `startLlamaServer` only polls for four seconds, and a large GGUF routinely
  // takes longer than that to load — so `online: false` is "not ready YET",
  // not "wedged". Give it a real readiness budget before judging.
  const ready = started.online || await waitForEndpoint(started.endpoint);
  if (!ready) {
    // Still silent. Treat it exactly like a rejected launch line: put the
    // previous configuration back, so the install's llama provider is not left
    // pointing at a process that never serves. Without this the caller would go
    // on to measure a dead endpoint and record the timeouts as evidence.
    console.error('❌ llama-server: relaunched process never answered — restoring the previous configuration');
    await stopLlamaServer().catch(() => {});
    await waitForPortRelease(previous.port ?? PORTS.LLAMA_SERVER);
    const restored = await startLlamaServer(previous).catch((err) => {
      console.error(`❌ llama-server: could not restore the previous configuration: ${err.message}`);
      return null;
    });
    return {
      applied: false,
      reason: 'llama-server relaunched but never answered on its port',
      config: restored?.config || null,
    };
  }
  return { applied: true, reason: null, config: started.config };
}

/**
 * Runs `brew link --overwrite llama.cpp`, resolving `{ linked, output }` on exit
 * rather than rejecting — a failed link attempt should fall through to the
 * caller's own error message, not replace it with a `brew link` failure. The
 * captured output is what makes a failure diagnosable ("Could not symlink…",
 * a permissions error on the prefix); discarding it left the caller guessing.
 */
function linkLlamaCpp(env) {
  return new Promise((resolve) => {
    const spawnOpts = safeChildProcessOptions({
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = spawn('brew', ['link', '--overwrite', 'llama.cpp'], spawnOpts);
    let output = '';
    const collect = (chunk) => { output += chunk.toString(); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => resolve({ linked: false, output: err.message }));
    // 'close' rather than 'exit': 'exit' fires the moment the process ends, with
    // stdio possibly still buffered, which would hand back a truncated (often
    // empty) `output` exactly when a failure needs explaining. `brew link` is a
    // short, single-process command, so waiting for the pipes to close is safe.
    child.on('close', (code) => resolve({ linked: code === 0, output: output.trim() }));
  });
}

/**
 * Installs llama.cpp via Homebrew.
 */
export async function installLlamaServer({ onProgress = () => {} } = {}) {
  const brewExists = await commandExists('brew', ['--version']);
  if (!brewExists) {
    throw new ServerError(
      'Homebrew was not found. Please install Homebrew from https://brew.sh or build llama.cpp from source.',
      { status: 400 }
    );
  }

  onProgress({ event: 'start', message: 'Installing llama.cpp via Homebrew…' });
  const env = safeChildProcessEnv();
  const spawnOpts = safeChildProcessOptions({
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const child = spawn('brew', ['install', 'llama.cpp'], spawnOpts);

  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (d) => {
      onProgress({ event: 'progress', message: d.toString().trim() });
    });
    child.stderr?.on('data', (d) => {
      onProgress({ event: 'progress', message: d.toString().trim() });
    });
    // `error` and `exit` can both fire for one child (an `error` raised after a
    // successful spawn is followed by the process's own exit). Without this
    // guard the exit path would still emit a `complete` progress event to the
    // UI after the request had already been rejected — the client would render
    // "installed successfully" alongside a 500.
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new ServerError(`Failed to run brew: ${err.message}`, { status: 500 }));
    });
    // Async listener on a child-process event: it runs outside the Express
    // lifecycle AND outside this Promise executor's own throw path, so an
    // unguarded throw here would surface as an unhandled rejection while the
    // install request hung forever. Route every failure to `reject`.
    child.on('exit', async (code) => {
      if (settled) return;
      settled = true;
      try {
        let binaryPath = resolveLlamaServerBinary();
        let linkOutput = '';

        // `brew install` exits 0 without linking when the keg is already
        // installed but unlinked ("Warning: llama.cpp X is already installed,
        // it's just not linked."). Link it explicitly rather than leaving that
        // warning as a dead end for the caller.
        if (!binaryPath && code === 0) {
          onProgress({ event: 'progress', message: 'llama.cpp keg is installed but not linked — linking…' });
          const { linked, output } = await linkLlamaCpp(env);
          linkOutput = output;
          if (linked) binaryPath = resolveLlamaServerBinary();
        }

        if (binaryPath) {
          onProgress({ event: 'complete', message: `llama.cpp installed successfully (${binaryPath})` });
          resolve({ success: true, message: 'llama.cpp installed successfully' });
          return;
        }

        // A `brew link` conflict can list every clashing file, so cap what
        // rides along into the error message.
        const hint = linkOutput
          ? `brew link said: ${linkOutput.slice(0, 500)}`
          : 'try running `brew link --overwrite llama.cpp` manually';
        const msg = code === 0
          ? `brew completed but llama-server was not found on PATH — ${hint}`
          : `brew install llama.cpp failed (exit code ${code})`;
        reject(new ServerError(msg, { status: 500 }));
      } catch (err) {
        reject(new ServerError(`Failed to verify the llama.cpp install: ${err.message}`, { status: 500 }));
      }
    });
  });
}

/**
 * Clears in-memory test state (used by test suites).
 */
export function _resetLlamaServerStateForTests({ relaunchReadyTimeout } = {}) {
  currentConfig = null;
  logs.reset();
  lastExitError = null;
  // Restored to the production budget unless a suite asks for a shorter one.
  relaunchReadyTimeoutMs = Number.isFinite(relaunchReadyTimeout) ? relaunchReadyTimeout : 120000;
}


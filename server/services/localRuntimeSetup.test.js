import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pinPlatform } from '../lib/testHelper.js';

const probe = vi.hoisted(() => ({ probeOpenAiModels: vi.fn() }));
vi.mock('../lib/openAiModelsProbe.js', () => probe);

const pathLookup = vi.hoisted(() => ({
  findCommandOnPath: vi.fn(() => null),
  safeChildProcessEnv: (extra = {}) => ({ ...extra }),
  safeChildProcessOptions: (opts = {}) => opts,
}));
vi.mock('../lib/processEnv.js', () => pathLookup);

const streaming = vi.hoisted(() => ({ runStreamingCommand: vi.fn(async () => ({ success: true })) }));
vi.mock('../lib/streamingSpawn.js', () => streaming);

const commands = vi.hoisted(() => ({ commandExists: vi.fn(async () => true) }));
vi.mock('../lib/commandExists.js', () => commands);

// The three managers this module delegates to for the runtimes PortOS already
// knew how to install. Mocked so the suite never touches Homebrew or a daemon.
const llama = vi.hoisted(() => ({ installLlamaServer: vi.fn(async () => ({ success: true })) }));
vi.mock('./llamaServerManager.js', () => llama);
const localLlm = vi.hoisted(() => ({
  installBackend: vi.fn(async () => ({ success: true })),
  controlOllamaServer: vi.fn(async () => ({ success: true })),
}));
vi.mock('./localLlm.js', () => localLlm);
vi.mock('./lmStudioManager.js', () => ({ isAppInstalled: () => false }));
const child = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../lib/childProcess.js', () => child);
// MTPLX's model cache — the setup asks it what is actually cached before it
// starts a server that would otherwise exit 1 looking for a checkpoint.
const mtplxCache = vi.hoisted(() => ({ listMtplxCachedModels: vi.fn() }));
// PARTIAL mock: only the subprocess call is faked. `describeMtplxCache` and
// `pickMtplxCachedModel` are pure classifiers of that output, and stubbing them
// would let a wrong reading of a real cache listing pass here.
vi.mock('../lib/mtplxModels.js', async (importOriginal) => ({ ...(await importOriginal()), ...mtplxCache }));
vi.mock('../lib/fileUtils.js', () => ({ sleep: async () => {} }));
// The vLLM compose project on disk. Mocked so the suite never stats a real
// checkout, and so each start case can pick its own refusal.
const vllmProject = vi.hoisted(() => ({
  inspectVllmQwenProject: vi.fn(),
  vllmStartBlockedReason: vi.fn(() => null),
}));
vi.mock('../lib/vllmQwenProject.js', () => vllmProject);

import { describeRuntimeSetup, runLocalRuntimeSetup, SETUP_ACTIONS, SETUP_RUNTIME_KINDS } from './localRuntimeSetup.js';

const unreachable = { reachable: false, models: null, error: 'ECONNREFUSED' };
/** A spawned daemon whose stdio never emits, driven entirely by the poll loop. */
const fakeChild = () => {
  const stream = () => ({ on: vi.fn(), off: vi.fn(), resume: vi.fn() });
  const handlers = {};
  return {
    stdout: stream(),
    stderr: stream(),
    on: vi.fn((event, fn) => { handlers[event] = fn; }),
    off: vi.fn(),
    unref: vi.fn(),
    emitEvent: (event, ...args) => handlers[event]?.(...args),
  };
};
const reachable = (models = ['mtplx']) => ({ reachable: true, models, error: null });

const cachedModels = (models) => ({ models, error: null });

const preparedVllmProject = { dir: '/home/example/qwen-serving', hasProject: true, composeFile: 'docker-compose.yml', hasWeights: true, weightsRoot: '/home/example/qwen-serving/models' };

beforeEach(() => {
  vllmProject.inspectVllmQwenProject.mockResolvedValue(preparedVllmProject);
  vllmProject.vllmStartBlockedReason.mockReturnValue(null);
  // Implementations AND return values (not just call records) survive
  // `clearAllMocks`. A probe implementation left over from an earlier test drives
  // this module's poll loop for its full three-minute timeout, and a leftover
  // `spawn` return value hands a stale child to whichever test spawns next.
  probe.probeOpenAiModels.mockReset();
  child.spawn.mockReset();
  mtplxCache.listMtplxCachedModels.mockResolvedValue(cachedModels([{ repo_id: 'Example/MTP-Model', validation: { ok: true } }]));
});

afterEach(() => {
  vi.clearAllMocks();
  pathLookup.findCommandOnPath.mockReturnValue(null);
  commands.commandExists.mockResolvedValue(true);
  streaming.runStreamingCommand.mockResolvedValue({ success: true });
});

describe('describeRuntimeSetup', () => {
  it('covers every runtime the readiness checklist can report', () => {
    expect([...SETUP_RUNTIME_KINDS].sort()).toEqual(['llama', 'lmstudio', 'mtplx', 'ollama', 'vllm']);
  });

  it('offers install AND start when nothing is there yet', () => {
    const restore = pinPlatform('darwin');
    expect(describeRuntimeSetup('mtplx', { installed: false, running: false })).toEqual({
      runtime: 'mtplx',
      label: 'MTPLX',
      action: 'install-start',
      actionLabel: 'Install & start MTPLX',
      blockedReason: null,
    });
    restore();
  });

  it('offers only a start once the runtime is installed', () => {
    const restore = pinPlatform('darwin');
    expect(describeRuntimeSetup('mtplx', { installed: true, running: false })).toMatchObject({
      action: 'start',
      actionLabel: 'Start MTPLX',
    });
    restore();
  });

  it('offers the DOWNLOAD, not a start, when the installed runtime has no weights', () => {
    // The catch-22 this exists to end: "installed ✓ / not responding — press
    // Start", where Start could only ever answer "no model weights are cached".
    const restore = pinPlatform('darwin');
    for (const weights of ['empty', 'partial']) {
      expect(describeRuntimeSetup('mtplx', { installed: true, running: false, weights })).toMatchObject({
        action: 'pull-start',
        actionLabel: 'Download the default model & start MTPLX',
      });
    }
    restore();
  });

  it('keeps a plain start when the cache is READY or unreadable', () => {
    const restore = pinPlatform('darwin');
    // Weights are already there — nothing to download.
    expect(describeRuntimeSetup('mtplx', { installed: true, running: false, weights: 'ready' })).toMatchObject({ action: 'start' });
    // Unreadable is not empty: a start that would have worked must not be
    // turned into a multi-gigabyte download.
    expect(describeRuntimeSetup('mtplx', { installed: true, running: false, weights: 'unknown' })).toMatchObject({ action: 'start' });
    restore();
  });

  it('never offers a download for a runtime with no pull step', () => {
    // Ollama's weights come from the Models → LLMs page, so an empty cache
    // there must not conjure a button this module cannot honour.
    expect(describeRuntimeSetup('ollama', { installed: true, running: false, weights: 'empty' }))
      .toMatchObject({ action: 'start' });
  });

  it('offers nothing once the daemon is installed and up — the model is the user\'s choice', () => {
    const restore = pinPlatform('darwin');
    // A running daemon serving the wrong alias is the remaining unmet check,
    // and PortOS will not pick (or download) a checkpoint for the user.
    expect(describeRuntimeSetup('mtplx', { installed: true, running: true })).toBeNull();
    restore();
  });

  it('names the reason instead of a button on an unsupported host', () => {
    const restore = pinPlatform('linux');
    expect(describeRuntimeSetup('mtplx', { installed: false, running: false })).toMatchObject({
      action: null,
      blockedReason: expect.stringMatching(/only on macOS/),
    });
    restore();
  });

  it('stops at the install for llama.cpp, which cannot start without weights', () => {
    // `start: null` — llama-server takes a required model path, so an installed
    // but stopped llama.cpp gets no button at all.
    expect(describeRuntimeSetup('llama', { installed: false, running: false })).toMatchObject({ action: 'install' });
    expect(describeRuntimeSetup('llama', { installed: true, running: false })).toBeNull();
  });

  it('returns null for a runtime it has no row for', () => {
    expect(describeRuntimeSetup('orcarouter', { installed: false, running: false })).toBeNull();
    expect(describeRuntimeSetup(undefined, { installed: false, running: false })).toBeNull();
  });
});

describe('runLocalRuntimeSetup', () => {
  it('does nothing when the endpoint already answers — on ANY platform', async () => {
    // Pinned to a platform this runtime cannot be installed on: a daemon that
    // answers is running, and the macOS-only gate must not turn that into
    // "MTPLX runs only on macOS". (Left unpinned this passed on a macOS dev box
    // and failed on the Linux CI runner, which is how the ordering bug surfaced.)
    const restore = pinPlatform('linux');
    probe.probeOpenAiModels.mockResolvedValueOnce(reachable());

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(result).toMatchObject({ success: true, message: expect.stringMatching(/already running/) });
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
  });

  it('installs MTPLX from its Homebrew tap — never the privileged fan-control helper', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    const [cmd, args] = streaming.runStreamingCommand.mock.calls[0];
    expect(cmd).toBe('brew');
    expect(args).toEqual(['install', 'youssofal/mtplx/mtplx']);
    expect(streaming.runStreamingCommand.mock.calls.flatMap(([, a]) => a)).not.toContain('max');
  });

  it('falls back to pip when Homebrew is absent', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    commands.commandExists.mockImplementation(async (cmd) => cmd !== 'brew');
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(streaming.runStreamingCommand.mock.calls[0][0]).toBe('python3');
  });

  it('stops at the install failure rather than starting a daemon that is not there', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    streaming.runStreamingCommand.mockResolvedValue({ success: false, error: 'exit 1: no such formula' });
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no such formula/) });
  });

  it('refuses a host that cannot run the runtime at all', async () => {
    probe.probeOpenAiModels.mockResolvedValueOnce(unreachable);
    const restore = pinPlatform('win32');
    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/only on macOS/) });
  });

  it('skips the start step when the install already brought the daemon up', async () => {
    // Ollama's Homebrew service starts on install. Launching a second copy onto
    // the same port is the failure this re-probe exists to prevent.
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)      // pre-flight
      .mockResolvedValueOnce(reachable([]))    // after install
      .mockResolvedValueOnce(reachable(['qwen3']));

    const result = await runLocalRuntimeSetup('ollama', { endpoint: 'http://localhost:11434/v1' });

    expect(localLlm.installBackend).toHaveBeenCalledWith('ollama', expect.any(Function));
    expect(localLlm.controlOllamaServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, message: expect.stringContaining('qwen3') });
  });

  it('starts an installed-but-stopped Ollama', async () => {
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/ollama');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['qwen3']));

    const result = await runLocalRuntimeSetup('ollama', { endpoint: 'http://localhost:11434/v1' });

    expect(localLlm.installBackend).not.toHaveBeenCalled();
    expect(localLlm.controlOllamaServer).toHaveBeenCalledWith('start');
    expect(result.success).toBe(true);
  });

  it('reports the install as done for llama.cpp and hands the model choice back', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);

    const result = await runLocalRuntimeSetup('llama', { endpoint: 'http://127.0.0.1:8080/v1' });

    expect(llama.installLlamaServer).toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, message: expect.stringMatching(/Models → LLMs/) });
  });

  it('stops after the install when the modal was closed', async () => {
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', {
      endpoint: 'http://127.0.0.1:8000/v1',
      isCancelled: () => true,
    });
    restore();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/Cancelled/) });
  });

  it('starts `mtplx serve` on the port the PROVIDER points at, not a hard-coded 8000', async () => {
    const daemon = fakeChild();
    child.spawn.mockReturnValue(daemon);
    // Not installed at the pre-flight check; on PATH once the install lands.
    pathLookup.findCommandOnPath.mockReturnValueOnce(null).mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)           // pre-flight
      .mockResolvedValueOnce(unreachable)           // after install
      .mockResolvedValueOnce(reachable(['mtplx']))  // first poll after spawn
      .mockResolvedValueOnce(reachable(['mtplx'])); // final confirmation
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8010/v1' });
    restore();

    const [binary, args] = child.spawn.mock.calls[0];
    expect(binary).toBe('/opt/homebrew/bin/mtplx');
    expect(args).toEqual(['serve', '--port', '8010', '--model', 'Example/MTP-Model']);
    expect(daemon.unref).toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, message: expect.stringContaining('http://127.0.0.1:8010/v1') });
  });

  it('detaches every listener from the daemon it leaves running', async () => {
    // The daemon outlives the request. Any listener still attached pins the
    // closure scope holding `emit` — and through it the SSE response — for the
    // daemon's whole lifetime. The `error` slot is REPLACED rather than left
    // empty: an EventEmitter `error` with no listener throws, and outside the
    // request lifecycle that takes the process down.
    const daemon = fakeChild();
    child.spawn.mockReturnValue(daemon);
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']))
      .mockResolvedValueOnce(reachable(['mtplx']));
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    const detached = daemon.off.mock.calls.map(([event]) => event);
    expect(detached).toContain('error');
    expect(detached).toContain('exit');
    for (const stream of [daemon.stdout, daemon.stderr]) {
      expect(stream.off).toHaveBeenCalledWith('data', expect.any(Function));
      // …and keep draining, so a full pipe can't block the daemon's next write.
      expect(stream.resume).toHaveBeenCalled();
    }
    // A no-op error listener is parked in place of the one that was removed.
    expect(daemon.on.mock.calls.filter(([event]) => event === 'error')).toHaveLength(2);
  });

  it('reports a daemon that died on startup instead of waiting out the timeout', async () => {
    const daemon = fakeChild();
    child.spawn.mockReturnValue(daemon);
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockImplementation(async () => {
      daemon.emitEvent('exit', 1, null);
      return unreachable;
    });
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/exited early \(code 1\)/) });
  });

  it('refuses to start MTPLX with an EMPTY model cache, naming the pull command', async () => {
    // `mtplx serve` defaults to one hard-coded checkpoint and exits 1 before it
    // binds when nothing is cached. Spawning it anyway is how "Start MTPLX"
    // reported "exited early (code 1)" and left the user with no next step.
    mtplxCache.listMtplxCachedModels.mockResolvedValue(cachedModels([]));
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(child.spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('mtplx pull') });
  });

  it('downloads the default checkpoint and then starts, but ONLY for `pull-start`', async () => {
    // The other half of the fix: the button the checklist now offers actually
    // fetches the weights, so the user is not sent to a terminal.
    const daemon = fakeChild();
    child.spawn.mockReturnValue(daemon);
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    // The cache is read by the START step, which runs AFTER the pull — so what
    // it reports here is what the download just landed.
    mtplxCache.listMtplxCachedModels
      .mockResolvedValueOnce(cachedModels([{ repo_id: 'Example/Fresh', validation: { ok: true } }]));
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']))
      .mockResolvedValueOnce(reachable(['mtplx']));
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', action: 'pull-start' });
    restore();

    expect(streaming.runStreamingCommand).toHaveBeenCalledWith(
      '/opt/homebrew/bin/mtplx', ['pull'], expect.any(Function), expect.objectContaining({ splitRe: expect.any(RegExp) }),
    );
    expect(child.spawn.mock.calls[0][1]).toEqual(['serve', '--port', '8000', '--model', 'Example/Fresh']);
    expect(result.success).toBe(true);
  });

  it('never downloads weights behind a plain start', async () => {
    // A multi-gigabyte download is a decision; only the button that says so
    // may spend it. Both of the refusals below reach `mtplx pull` in PROSE.
    mtplxCache.listMtplxCachedModels.mockResolvedValue(cachedModels([]));
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', action: 'start' });
    await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
  });

  it('stops at a failed download rather than starting a server that cannot serve', async () => {
    streaming.runStreamingCommand.mockResolvedValue({ success: false, error: 'exit 1: connection reset' });
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1', action: 'pull-start' });
    restore();

    expect(child.spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('connection reset') });
  });

  it('exposes every action the route may accept', () => {
    expect([...SETUP_ACTIONS].sort()).toEqual(['install', 'install-start', 'pull-start', 'start']);
  });

  it('refuses when every cached MTPLX model is an incomplete download', async () => {
    mtplxCache.listMtplxCachedModels.mockResolvedValue(cachedModels([{ repo_id: 'Example/Partial', validation: { ok: false } }]));
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(child.spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/none passed its own file check/) });
  });

  it('starts MTPLX on its own default when the cache cannot be READ', async () => {
    // Unreadable is not empty: blocking here would refuse a start that works.
    mtplxCache.listMtplxCachedModels.mockResolvedValue({ models: null, error: '`mtplx models` timed out' });
    const daemon = fakeChild();
    child.spawn.mockReturnValue(daemon);
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(reachable(['mtplx']))
      .mockResolvedValueOnce(reachable(['mtplx']));
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(child.spawn.mock.calls[0][1]).toEqual(['serve', '--port', '8000']);
    expect(result.success).toBe(true);
  });

  it('does not spawn a daemon when the modal closed while the cache was being read', async () => {
    // The cache lookup is an awaited subprocess, and the caller's cancellation
    // check ran BEFORE it — without a re-check, a closed modal still leaves a
    // detached MTPLX server running.
    let cancelled = false;
    mtplxCache.listMtplxCachedModels.mockImplementation(async () => {
      cancelled = true; // the user closes the modal while `mtplx models` runs
      return cachedModels([{ repo_id: 'Example/MTP-Model', validation: { ok: true } }]);
    });
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', {
      endpoint: 'http://127.0.0.1:8000/v1',
      isCancelled: () => cancelled,
    });
    restore();

    expect(child.spawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/Cancelled/) });
  });

  it('reports what a dying daemon printed, skipping its ASCII-art banner', async () => {
    const daemon = fakeChild();
    child.spawn.mockReturnValue(daemon);
    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    // The stdout handler is registered as `on('data', …)` — feed it the way the
    // real stream would, split across chunks mid-line.
    const feed = (chunk) => daemon.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1](chunk);
    let printed = false;
    probe.probeOpenAiModels.mockImplementation(async () => {
      // Only once the daemon has been spawned and its stdout hooked up.
      if (daemon.stdout.on.mock.calls.length > 0 && !printed) {
        printed = true;
        feed('╭──────────╮\n╰──────────╯\nerror: model is not ava');
        feed('ilable locally\ndetail: run mtplx pull\n');
        daemon.emitEvent('exit', 1, null);
      }
      return unreachable;
    });
    const restore = pinPlatform('darwin');

    const result = await runLocalRuntimeSetup('mtplx', { endpoint: 'http://127.0.0.1:8000/v1' });
    restore();

    expect(result.error).toContain('exited early (code 1)');
    // Line reassembled across the chunk boundary, box drawing left out of it.
    expect(result.error).toContain('error: model is not available locally');
    expect(result.error).not.toContain('╭');
  });

  it('refuses a runtime kind it has no row for', async () => {
    const result = await runLocalRuntimeSetup('made-up', { endpoint: 'http://127.0.0.1:9/v1' });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no automatic setup/) });
  });
});

describe('vllm — the container is brought up, never provisioned', () => {
  const vllmEndpoint = 'http://127.0.0.1:18020/v1';

  it('is unsupported on darwin, and says where Mac users should go instead', () => {
    const restore = pinPlatform('darwin');
    expect(describeRuntimeSetup('vllm', { installed: false, running: false })).toMatchObject({
      runtime: 'vllm',
      action: null,
      blockedReason: expect.stringMatching(/MTPLX or llama.cpp DSpark/),
    });
    restore();
  });

  it('offers a start button on a Linux/Windows host with docker present', () => {
    const restore = pinPlatform('linux');
    expect(describeRuntimeSetup('vllm', { installed: true, running: false })).toMatchObject({
      runtime: 'vllm',
      action: 'start',
      blockedReason: null,
    });
    restore();
  });

  it('brings up an already-prepared compose project in its own directory', async () => {
    const restore = pinPlatform('linux');
    pathLookup.findCommandOnPath.mockReturnValue('/usr/bin/docker');
    probe.probeOpenAiModels
      .mockResolvedValueOnce(unreachable)   // initial
      .mockResolvedValueOnce(unreachable)   // after "install"
      .mockResolvedValue(reachable(['qwen3.8-27b'])); // confirm

    const result = await runLocalRuntimeSetup('vllm', { endpoint: vllmEndpoint, emit: () => {} });

    expect(result.success).toBe(true);
    expect(streaming.runStreamingCommand).toHaveBeenCalledWith(
      'docker',
      ['compose', '--profile', 'single', 'up', '-d'],
      expect.any(Function),
      expect.objectContaining({ cwd: preparedVllmProject.dir }),
    );
    restore();
  });

  it('refuses to run compose when the project is not demonstrably prepared', async () => {
    const restore = pinPlatform('linux');
    pathLookup.findCommandOnPath.mockReturnValue('/usr/bin/docker');
    probe.probeOpenAiModels.mockResolvedValue(unreachable);
    vllmProject.vllmStartBlockedReason.mockReturnValue('no Qwen weights are cached yet');

    const result = await runLocalRuntimeSetup('vllm', { endpoint: vllmEndpoint, emit: () => {} });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no Qwen weights are cached/) });
    // The whole point: a 20 GB pull is never started on the user's behalf.
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
    restore();
  });

  it('never installs docker, WSL2, or the container toolkit', async () => {
    const restore = pinPlatform('linux');
    pathLookup.findCommandOnPath.mockReturnValue(null); // docker not on PATH
    probe.probeOpenAiModels.mockResolvedValue(unreachable);

    const result = await runLocalRuntimeSetup('vllm', { endpoint: vllmEndpoint, emit: () => {} });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/does not install this stack/) });
    expect(streaming.runStreamingCommand).not.toHaveBeenCalled();
    expect(localLlm.installBackend).not.toHaveBeenCalled();
    restore();
  });
});

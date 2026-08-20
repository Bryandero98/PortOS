import { afterEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../lib/fileUtils.js', () => ({ sleep: async () => {} }));

import { describeRuntimeSetup, runLocalRuntimeSetup, SETUP_RUNTIME_KINDS } from './localRuntimeSetup.js';

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

afterEach(() => {
  vi.clearAllMocks();
  pathLookup.findCommandOnPath.mockReturnValue(null);
  commands.commandExists.mockResolvedValue(true);
  streaming.runStreamingCommand.mockResolvedValue({ success: true });
});

describe('describeRuntimeSetup', () => {
  it('covers every runtime the readiness checklist can report', () => {
    expect([...SETUP_RUNTIME_KINDS].sort()).toEqual(['llama', 'lmstudio', 'mtplx', 'ollama']);
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
    expect(result).toMatchObject({ success: true, message: expect.stringMatching(/Local LLM/) });
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
    expect(args).toEqual(['serve', '--port', '8010']);
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

  it('refuses a runtime kind it has no row for', async () => {
    const result = await runLocalRuntimeSetup('made-up', { endpoint: 'http://127.0.0.1:9/v1' });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/no automatic setup/) });
  });
});

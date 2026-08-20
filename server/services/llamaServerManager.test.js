import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  getLlamaServerStatus,
  startLlamaServer,
  stopLlamaServer,
  installLlamaServer,
  _resetLlamaServerStateForTests,
} from './llamaServerManager.js';
import * as processEnv from '../lib/processEnv.js';
import * as commandExistsModule from '../lib/commandExists.js';
import * as childProcess from '../lib/childProcess.js';
import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

function fakeSpawnProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// A real child emits 'exit' and then 'close' (once stdio has flushed). Mirror
// both so the mocks stay honest for either listener: `brew install` is awaited
// on 'exit', while the `brew link` step waits for 'close' to capture output.
function endProcess(child, code) {
  child.emit('exit', code);
  child.emit('close', code);
}

describe('llamaServerManager', () => {
  // startLlamaServer refuses to spawn for a GGUF that is not on disk, so the
  // lifecycle tests need real files to point at.
  let modelDir;
  let modelPath;
  let draftPath;

  beforeAll(async () => {
    modelDir = await mkdtemp(join(tmpdir(), 'portos-llama-'));
    modelPath = join(modelDir, 'model.gguf');
    draftPath = join(modelDir, 'draft.gguf');
    await writeFile(modelPath, 'gguf');
    await writeFile(draftPath, 'gguf');
  });

  afterAll(async () => {
    await rm(modelDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetLlamaServerStateForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    _resetLlamaServerStateForTests();
    vi.restoreAllMocks();
  });

  it('reports installed: false when binary is not found on PATH', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    const status = await getLlamaServerStatus();
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.managed).toBe(false);
  });

  it('reports installed: true when binary is found on PATH', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/opt/homebrew/bin/llama-server');
    const execProbe = vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(true);

    const status = await getLlamaServerStatus();
    expect(status.installed).toBe(true);
    // Regression: the binary must never be executed to answer
    // "installed?". llama.cpp initializes its ggml/Metal backends at launch, so
    // a cold run right after `brew link` blew past commandExists' 5s bound and
    // reported an installed, working binary as missing.
    expect(execProbe).not.toHaveBeenCalled();
  });

  it('rejects start when binary is missing', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    await expect(startLlamaServer({ model: modelPath })).rejects.toThrow(
      /llama-server binary was not found/i
    );
  });

  it('spawns llama-server with draftModel and specType arguments', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    const fakeChild = new EventEmitter();
    fakeChild.pid = 12345;
    fakeChild.killed = false;
    fakeChild.exitCode = null;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    let spawnArgs = null;
    vi.spyOn(childProcess, 'spawn').mockImplementation((cmd, args) => {
      spawnArgs = { cmd, args };
      return fakeChild;
    });

    const result = await startLlamaServer({
      model: modelPath,
      draftModel: draftPath,
      specType: 'draft-dflash',
      port: 8080,
      host: '127.0.0.1',
      alias: 'dflash',
    });

    expect(result.success).toBe(true);
    expect(result.pid).toBe(12345);
    expect(spawnArgs.cmd).toBe('/usr/local/bin/llama-server');
    // The drafter flag was once spelled `--draft-model`, which llama.cpp has
    // never accepted — it exits 1 on an unknown flag before touching the
    // weights, so every speculative launch died on arrival. Pinning the exact
    // argv is what keeps a plausible-looking misspelling out.
    expect(spawnArgs.args).toEqual([
      '-m', modelPath,
      '--model-draft', draftPath,
      '--spec-type', 'draft-dflash',
      '--port', '8080',
      '--host', '127.0.0.1',
      '--ctx-size', '32768',
      '-ngl', '99',
      '--alias', 'dflash',
    ]);

    const status = await getLlamaServerStatus();
    expect(status.running).toBe(true);
    expect(status.managed).toBe(true);
    expect(status.pid).toBe(12345);
  });

  it('refuses to start when the GGUF the launch line names is not on disk', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');
    const spawnSpy = vi.spyOn(childProcess, 'spawn');

    await expect(startLlamaServer({ model: join(modelDir, 'absent.gguf') })).rejects.toThrow(
      /base model was not found/i
    );
    await expect(startLlamaServer({ model: modelPath, draftModel: join(modelDir, 'absent.gguf') })).rejects.toThrow(
      /drafter model was not found/i
    );
    // The weights are a separate multi-gigabyte download; spawning anyway just
    // buries that in a server log.
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('reports a failure — not a PID — when llama-server exits during startup', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    const fakeChild = new EventEmitter();
    fakeChild.pid = 999;
    fakeChild.killed = false;
    fakeChild.exitCode = null;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      // A real llama.cpp rejects an unsupported --spec-type within a beat.
      setTimeout(() => {
        fakeChild.stderr.emit('data', Buffer.from('error: unknown spec type\n'));
        fakeChild.exitCode = 1;
        fakeChild.emit('exit', 1, null);
      }, 0);
      return fakeChild;
    });

    await expect(startLlamaServer({ model: modelPath, specType: 'draft-nope' })).rejects.toThrow(
      /llama-server exited immediately/i
    );
  });

  it('stops managed process cleanly', async () => {
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/usr/local/bin/llama-server');

    const fakeChild = new EventEmitter();
    fakeChild.pid = 54321;
    fakeChild.killed = false;
    fakeChild.exitCode = null;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = vi.fn();

    vi.spyOn(childProcess, 'spawn').mockReturnValue(fakeChild);

    await startLlamaServer({ model: modelPath });
    const stopResult = await stopLlamaServer();
    expect(stopResult.success).toBe(true);

    const status = await getLlamaServerStatus();
    expect(status.managed).toBe(false);
  });

  it('installs llama.cpp via Homebrew when brew is available', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => true);
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue('/opt/homebrew/bin/llama-server');

    const fakeChild = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      setTimeout(() => endProcess(fakeChild, 0), 10);
      return fakeChild;
    });

    const result = await installLlamaServer();
    expect(result.success).toBe(true);
  });

  it('rejects install when Homebrew is missing', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(false);

    await expect(installLlamaServer()).rejects.toThrow(/Homebrew was not found/i);
  });

  it('links an already-installed-but-unlinked keg after `brew install` exits 0', async () => {
    // brew is present; llama-server is NOT on PATH until after the link step.
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd === 'brew');
    const findSpy = vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    const installChild = fakeSpawnProcess();
    const linkChild = fakeSpawnProcess();
    const spawnCalls = [];
    vi.spyOn(childProcess, 'spawn').mockImplementation((cmd, args) => {
      spawnCalls.push({ cmd, args });
      const child = args[0] === 'install' ? installChild : linkChild;
      setTimeout(() => endProcess(child, 0), 10);
      return child;
    });

    const resultPromise = installLlamaServer();

    // Once `brew link` resolves, the binary shows up on PATH.
    setTimeout(() => {
      findSpy.mockReturnValue('/opt/homebrew/bin/llama-server');
    }, 15);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(spawnCalls).toEqual([
      { cmd: 'brew', args: ['install', 'llama.cpp'] },
      { cmd: 'brew', args: ['link', '--overwrite', 'llama.cpp'] },
    ]);
  });

  it('surfaces brew link output when the link step fails', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd === 'brew');
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    vi.spyOn(childProcess, 'spawn').mockImplementation((cmd, args) => {
      const child = fakeSpawnProcess();
      setTimeout(() => {
        if (args[0] === 'link') {
          child.stderr.emit('data', Buffer.from('Error: Could not symlink bin/llama-server'));
          endProcess(child, 1);
        } else {
          endProcess(child, 0);
        }
      }, 10);
      return child;
    });

    await expect(installLlamaServer()).rejects.toThrow(/Could not symlink bin\/llama-server/);
  });

  it('rejects instead of hanging when the link spawn throws synchronously', async () => {
    // The exit listener is async and lives inside a Promise executor, so an
    // unguarded throw would escape as an unhandled rejection while the install
    // request never settled.
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd === 'brew');
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    vi.spyOn(childProcess, 'spawn').mockImplementation((cmd, args) => {
      if (args[0] === 'link') throw new Error('spawn EACCES');
      const child = fakeSpawnProcess();
      setTimeout(() => endProcess(child, 0), 10);
      return child;
    });

    await expect(installLlamaServer()).rejects.toThrow(/Failed to verify the llama\.cpp install: spawn EACCES/);
  });

  it('rejects with a `brew link` hint when linking does not resolve the binary', async () => {
    vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd === 'brew');
    vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);

    vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      const child = fakeSpawnProcess();
      setTimeout(() => endProcess(child, 0), 10);
      return child;
    });

    await expect(installLlamaServer()).rejects.toThrow(/brew link --overwrite llama\.cpp/i);
  });
});

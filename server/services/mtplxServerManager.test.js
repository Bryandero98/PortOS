import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getMtplxServerStatus,
  startMtplxServer,
  stopMtplxServer,
  installMtplx,
  _resetMtplxServerStateForTests,
  MTPLX_APP,
} from './mtplxServerManager.js';
import * as processEnv from '../lib/processEnv.js';
import * as platform from '../lib/platform.js';
import * as openAiModelsProbe from '../lib/openAiModelsProbe.js';
import * as mtplxModels from '../lib/mtplxModels.js';
import * as pm2Module from './pm2.js';
import * as commandExistsModule from '../lib/commandExists.js';
import * as streamingSpawn from '../lib/streamingSpawn.js';

const BINARY = '/opt/homebrew/bin/mtplx';
const cachedModel = (repoId, extra = {}) => ({ repo_id: repoId, validation: { ok: true }, ...extra });

describe('mtplxServerManager', () => {
  let pm2State = null;
  let execPm2Calls = [];

  beforeEach(() => {
    // A start that never answers on its port is the NORMAL path here (the probe
    // is pinned unreachable) — shorten the beat so the suite doesn't sit
    // through the production budget on every lifecycle test.
    _resetMtplxServerStateForTests({ startupWait: 50 });
    vi.restoreAllMocks();
    pm2State = null;
    execPm2Calls = [];

    // The host may genuinely be running MTPLX (or anything else) on :8000 — pin
    // both probes so a developer machine's real listeners can't decide these.
    vi.spyOn(platform, 'isPortInUse').mockResolvedValue(false);
    vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: false });
    vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(true);
    // The dump is a real file on the developer's machine; pin it so the
    // startsAtBoot assertions are about this code, not their PM2 state.
    vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue([]);
    vi.spyOn(mtplxModels, 'listMtplxCachedModels').mockResolvedValue({ models: [cachedModel('Example/Qwen-MTP')], error: null });

    vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
      execPm2Calls.push(args);
      if (args[0] === 'start') {
        const nameIdx = args.indexOf('--name');
        const dashIdx = args.indexOf('--');
        pm2State = {
          name: nameIdx !== -1 ? args[nameIdx + 1] : args[1],
          status: 'online',
          pid: 4242,
          args: dashIdx !== -1 ? args.slice(dashIdx + 1) : [],
        };
      }
      if (args[0] === 'delete') pm2State = null;
      return { stdout: '', stderr: '' };
    });
    vi.spyOn(pm2Module, 'getAppStatusStrict').mockImplementation(async (name) => (
      pm2State && pm2State.name === name ? pm2State : { name, status: 'not_found', pm2_env: null }
    ));
    vi.spyOn(pm2Module, 'clearJlistCache').mockImplementation(() => {});
  });

  afterEach(() => {
    _resetMtplxServerStateForTests();
    vi.restoreAllMocks();
  });

  describe('getMtplxServerStatus', () => {
    it('reports not installed when the binary is not on PATH', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      const status = await getMtplxServerStatus();
      expect(status.installed).toBe(false);
      expect(status.running).toBe(false);
      expect(status.managed).toBe(false);
      // A missing binary means the cache was never queried, so `cachedModels`
      // must not read as "queried and empty" plus a phantom error.
      expect(status.cacheError).toBeNull();
    });

    it('surfaces the cached checkpoints an installed MTPLX can be started on', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      const status = await getMtplxServerStatus();
      expect(status.installed).toBe(true);
      expect(status.cachedModels).toEqual(['Example/Qwen-MTP']);
      expect(status.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    });

    it('reports the platform gate only when nothing is installed here', async () => {
      vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(false);
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      expect((await getMtplxServerStatus()).supported).toBe(false);

      // A binary on PATH is proof this host runs it — "macOS only" would be a
      // false report about an install the user can see.
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      const installed = await getMtplxServerStatus();
      expect(installed.supported).toBe(true);
      expect(installed.unsupportedReason).toBeNull();
    });

    it('flags the process as boot-persisted only when the PM2 dump names it', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      expect((await getMtplxServerStatus()).runAtStartup).toBe(false);

      vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue([MTPLX_APP]);
      expect((await getMtplxServerStatus()).runAtStartup).toBe(true);

      // An unreadable dump is NOT "no" — it has to stay distinguishable so the
      // UI can say "unknown" instead of "won't come back after a reboot".
      vi.spyOn(pm2Module, 'getSavedProcessNames').mockResolvedValue(null);
      expect((await getMtplxServerStatus()).runAtStartup).toBeNull();
    });
  });

  describe('startMtplxServer', () => {
    beforeEach(() => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
    });

    it('starts `mtplx serve` under PM2 on a cached checkpoint', async () => {
      const result = await startMtplxServer();
      expect(result.success).toBe(true);
      expect(result.managed).toBe(true);

      const start = execPm2Calls.find((args) => args[0] === 'start');
      expect(start).toContain('--name');
      expect(start[start.indexOf('--name') + 1]).toBe(MTPLX_APP);
      const launch = start.slice(start.indexOf('--') + 1);
      // `serve` (API-only), never `start` — which is interactive and prompts.
      expect(launch[0]).toBe('serve');
      expect(launch).toContain('--model');
      expect(launch[launch.indexOf('--model') + 1]).toBe('Example/Qwen-MTP');
    });

    it('binds the port the caller asked for, so the provider endpoint matches', async () => {
      const result = await startMtplxServer({ port: 8010 });
      expect(result.endpoint).toBe('http://127.0.0.1:8010/v1');
      const launch = execPm2Calls.find((a) => a[0] === 'start');
      expect(launch[launch.indexOf('--port') + 1]).toBe('8010');
    });

    it('refuses with the `mtplx pull` fix when the cache was read and is empty', async () => {
      vi.spyOn(mtplxModels, 'listMtplxCachedModels').mockResolvedValue({ models: [], error: null });
      await expect(startMtplxServer()).rejects.toThrow(/mtplx pull/);
      expect(execPm2Calls.some((args) => args[0] === 'start')).toBe(false);
    });

    it('falls through to MTPLX\'s own default when the cache could not be READ', async () => {
      // `models: null` is "could not read", which must not block a start that
      // may well work — unlike `[]`, which means "read, and empty".
      vi.spyOn(mtplxModels, 'listMtplxCachedModels').mockResolvedValue({ models: null, error: 'mtplx models timed out' });
      const result = await startMtplxServer();
      expect(result.success).toBe(true);
      const launch = execPm2Calls.find((a) => a[0] === 'start');
      expect(launch).not.toContain('--model');
    });

    it('reports what a server that died on startup printed', async () => {
      // PM2 leaving `online` is the signal; its log tail is what turns "exited"
      // into something the user can act on.
      vi.spyOn(pm2Module, 'execPm2').mockImplementation(async (args) => {
        execPm2Calls.push(args);
        if (args[0] === 'start') {
          pm2State = { name: MTPLX_APP, status: 'errored', pid: null, args: [] };
        }
        if (args[0] === 'delete') pm2State = null;
        if (args[0] === 'logs') return { stdout: '', stderr: 'error: model is not available locally' };
        return { stdout: '', stderr: '' };
      });
      await expect(startMtplxServer()).rejects.toThrow(/model is not available locally/);
      // The failed entry is cleaned up so the next start isn't a name collision.
      expect(pm2State).toBeNull();
    });

    it('refuses when the binary is not installed', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(null);
      await expect(startMtplxServer()).rejects.toThrow(/not found on PATH/);
    });

    it('refuses rather than launching a second copy onto a bound port', async () => {
      vi.spyOn(platform, 'isPortInUse').mockResolvedValue(true);
      await expect(startMtplxServer()).rejects.toThrow(/already in use/);
    });
  });

  describe('installMtplx', () => {
    beforeEach(() => {
      vi.spyOn(streamingSpawn, 'runStreamingCommand').mockResolvedValue({ success: true });
    });

    it('installs from upstream\'s Homebrew tap, never the privileged fan-control helper', async () => {
      vi.spyOn(commandExistsModule, 'commandExists').mockResolvedValue(true);
      const result = await installMtplx();
      expect(result.success).toBe(true);
      const [cmd, args] = streamingSpawn.runStreamingCommand.mock.calls[0];
      expect(cmd).toBe('brew');
      expect(args).toEqual(['install', 'youssofal/mtplx/mtplx']);
      // `mtplx max --install` is upstream's one privileged path (a sudo fan
      // controller). It stays an explicit operator action outside PortOS.
      expect(streamingSpawn.runStreamingCommand.mock.calls.flatMap(([, a]) => a)).not.toContain('max');
    });

    it('falls back to pip on a host without Homebrew', async () => {
      vi.spyOn(commandExistsModule, 'commandExists').mockImplementation(async (cmd) => cmd !== 'brew');
      await installMtplx();
      expect(streamingSpawn.runStreamingCommand.mock.calls[0][0]).toBe('python3');
    });

    it('refuses on a host that cannot run MLX at all', async () => {
      vi.spyOn(platform, 'isAppleSilicon').mockReturnValue(false);
      await expect(installMtplx()).rejects.toThrow(/macOS with Apple Silicon/);
      expect(streamingSpawn.runStreamingCommand).not.toHaveBeenCalled();
    });
  });

  describe('stopMtplxServer', () => {
    it('deletes the PM2 process it manages', async () => {
      vi.spyOn(processEnv, 'findCommandOnPath').mockReturnValue(BINARY);
      await startMtplxServer();
      const result = await stopMtplxServer();
      expect(result.success).toBe(true);
      expect(pm2State).toBeNull();
    });

    it('will not claim to stop a server PortOS did not start', async () => {
      vi.spyOn(openAiModelsProbe, 'probeOpenAiModels').mockResolvedValue({ reachable: true });
      const result = await stopMtplxServer();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/external process/i);
    });

    it('is a no-op when nothing is running', async () => {
      const result = await stopMtplxServer();
      expect(result.success).toBe(true);
      expect(result.message).toMatch(/not running/i);
    });
  });
});

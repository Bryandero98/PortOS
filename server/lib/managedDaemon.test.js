import { describe, expect, it, vi } from 'vitest';
import { createDaemonWatcher } from './managedDaemon.js';

const makeWatcher = (overrides = {}) => {
  let config = overrides.config ?? null;
  const getAppStatus = vi.fn(async () => Object.hasOwn(overrides, 'pm2Status')
    ? overrides.pm2Status
    : { status: 'online', pid: 42, args: ['--port', '9001'] });
  const execPm2 = vi.fn(async () => ({ stdout: 'pm2 output', stderr: '' }));
  const isPortInUse = vi.fn(async () => false);
  const probe = vi.fn(async () => overrides.reachable ?? false);
  const watcher = createDaemonWatcher({
    appName: 'example-daemon',
    defaultPort: 9000,
    endpointFor: (value) => `http://127.0.0.1:${value?.port ?? 9000}/v1`,
    parseConfigFromArgs: (args) => ({ port: Number(args[args.indexOf('--port') + 1]) }),
    probe,
    isPortInUse,
    sleep: vi.fn(async () => {}),
    getConfig: () => config,
    setConfig: (value) => { config = value; },
    getLastExitError: () => null,
    getAppStatus,
    getSavedProcessNames: vi.fn(async () => ['example-daemon']),
    execPm2,
    getPortReleaseTimeoutMs: () => 5_000,
    ...overrides.options,
  });
  return { watcher, getAppStatus, execPm2, isPortInUse, probe, getConfig: () => config };
};

describe('createDaemonWatcher', () => {
  it('re-adopts a live PM2 launch line and builds the shared status fields', async () => {
    const { watcher, execPm2, probe, getConfig } = makeWatcher();

    const status = await watcher.getStatusBase({ installed: true });

    expect(getConfig()).toEqual({ port: 9001 });
    expect(status).toMatchObject({
      installed: true,
      running: true,
      managed: true,
      pid: 42,
      port: 9001,
      endpoint: 'http://127.0.0.1:9001/v1',
      config: { port: 9001 },
      runAtStartup: true,
      recentLogs: ['pm2 output'],
      lastExitError: null,
    });
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:9001/v1');
    expect(execPm2).toHaveBeenCalledWith(['logs', 'example-daemon', '--nostream', '--lines', '100']);
  });

  it('keeps an unreadable PM2 distinct from a confirmed missing process', async () => {
    const { watcher } = makeWatcher({
      config: { port: 9002 },
      pm2Status: null,
      options: { preserveConfigOnReadFailure: true },
    });

    await expect(watcher.getStatusBase({ installed: true })).resolves.toMatchObject({
      managed: null,
      config: { port: 9002 },
      lastExitError: 'Failed to read PM2 status',
    });
  });

  it('waits until a stopped daemon releases its port', async () => {
    const { watcher, isPortInUse } = makeWatcher();
    isPortInUse.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await watcher.waitForPortRelease(9001);

    expect(isPortInUse).toHaveBeenCalledTimes(2);
    expect(isPortInUse).toHaveBeenCalledWith(9001);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const readinessService = vi.hoisted(() => ({
  getProviderReadinessMap: vi.fn(),
  resetProviderReadinessCache: vi.fn(),
}));
vi.mock('../services/providerReadiness.js', () => readinessService);
const setupService = vi.hoisted(() => ({ runLocalRuntimeSetup: vi.fn() }));
// PARTIAL mock: `SETUP_ACTIONS` is the closed set the route validates against,
// and a stubbed copy would let a route accepting an action the service cannot
// run still pass here.
vi.mock('../services/localRuntimeSetup.js', async (importOriginal) => ({ ...(await importOriginal()), ...setupService }));
import { createPortOSProviderRoutes } from './providers.js';

// A provider whose real base URL lives in an env var the user marked secret —
// the shape that would be redacted to `***` by the client-facing sanitizer.
const CLAUDE_OLLAMA = {
  id: 'claude-ollama',
  name: 'Claude Ollama (local model)',
  command: 'claude',
  ollamaBacked: true,
  envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11500', ANTHROPIC_AUTH_TOKEN: 'ollama' },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
};

const app = (providers) => {
  const toolkit = {
    services: { providers: { getAllProviders: vi.fn().mockResolvedValue({ providers, activeProvider: null }) } },
    routes: { providers: Router() },
  };
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes(toolkit));
  server.use(errorMiddleware);
  return server;
};

describe('GET /api/providers/readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readinessService.getProviderReadinessMap.mockResolvedValue({});
  });

  it('publishes the readiness map keyed by provider id', async () => {
    readinessService.getProviderReadinessMap.mockResolvedValueOnce({
      'claude-ollama': { kind: 'ollama', label: 'Ollama', ready: false, checks: [{ id: 'server', ok: false }] },
    });

    const response = await request(app([CLAUDE_OLLAMA])).get('/api/providers/readiness');

    expect(response.status).toBe(200);
    expect(response.body.readiness['claude-ollama'].ready).toBe(false);
  });

  it('checks the RAW providers, so a base URL stored as a secret env var still resolves', async () => {
    await request(app([CLAUDE_OLLAMA])).get('/api/providers/readiness');

    const [providers] = readinessService.getProviderReadinessMap.mock.calls[0];
    expect(providers[0].envVars.ANTHROPIC_BASE_URL).toBe('http://localhost:11500');
    expect(providers[0].envVars.ANTHROPIC_AUTH_TOKEN).not.toBe('***');
  });
});

/** The SSE frames a streamed response carries, in order. */
const frames = (text) => text
  .split(/\r?\n\r?\n/)
  .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith('data:')))
  .filter(Boolean)
  .map((line) => JSON.parse(line.slice('data:'.length).trim()));

describe('POST /api/providers/readiness/setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readinessService.getProviderReadinessMap.mockResolvedValue({});
    setupService.runLocalRuntimeSetup.mockResolvedValue({ success: true, message: 'Ollama is running.' });
  });

  it('resolves the runtime and endpoint from the stored provider, never from the query', async () => {
    const response = await request(app([CLAUDE_OLLAMA]))
      .post('/api/providers/readiness/setup?provider=claude-ollama&runtime=ollama');

    expect(response.status).toBe(200);
    const [kind, ctx] = setupService.runLocalRuntimeSetup.mock.calls[0];
    expect(kind).toBe('ollama');
    // The base URL comes from the RAW provider record — a query string cannot
    // point the setup at a different port.
    expect(ctx.endpoint).toBe('http://localhost:11500/v1');
    expect(frames(response.text).at(-1)).toEqual({ type: 'complete', message: 'Ollama is running.' });
  });

  it('forwards the action the checklist button named, defaulting to install-start', async () => {
    // `pull-start` is the only action that downloads model weights, so it has
    // to survive the trip from the button to the service — and every older
    // client, which sends no action at all, must keep its old behavior.
    await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=claude-ollama&action=pull-start');
    expect(setupService.runLocalRuntimeSetup.mock.calls[0][1]).toMatchObject({ action: 'pull-start' });

    await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=claude-ollama');
    expect(setupService.runLocalRuntimeSetup.mock.calls[1][1]).toMatchObject({ action: 'install-start' });
  });

  it('rejects an action outside the fixed set rather than passing it through', async () => {
    const response = await request(app([CLAUDE_OLLAMA]))
      .post('/api/providers/readiness/setup?provider=claude-ollama&action=rm-rf');
    expect(response.status).toBe(400);
    expect(setupService.runLocalRuntimeSetup).not.toHaveBeenCalled();
  });

  it('drops the probe caches so the next poll sees the daemon that just came up', async () => {
    await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=claude-ollama');
    expect(readinessService.resetProviderReadinessCache).toHaveBeenCalled();
  });

  it('reports a failed setup as a terminal error frame, not a 500', async () => {
    setupService.runLocalRuntimeSetup.mockResolvedValueOnce({ success: false, error: 'brew exploded' });

    const response = await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=claude-ollama');

    expect(response.status).toBe(200);
    expect(frames(response.text).at(-1)).toEqual({ type: 'error', message: 'brew exploded' });
  });

  it('refuses a second concurrent setup rather than racing two installers', async () => {
    let release;
    setupService.runLocalRuntimeSetup.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ success: true, message: 'done' });
    }));
    const server = app([CLAUDE_OLLAMA]);

    // `.then()` is what starts the request — the builder is lazy, so a bare
    // call would never take the lock and the race under test wouldn't happen.
    const first = request(server).post('/api/providers/readiness/setup?provider=claude-ollama').then((r) => r);
    // Let the first request take the lock before the second one asks for it.
    await vi.waitFor(() => expect(setupService.runLocalRuntimeSetup).toHaveBeenCalled());
    const second = await request(server).post('/api/providers/readiness/setup?provider=claude-ollama');

    expect(frames(second.text).at(-1).type).toBe('error');
    expect(frames(second.text).at(-1).message).toMatch(/already running/);
    release();
    expect(frames((await first).text).at(-1)).toEqual({ type: 'complete', message: 'done' });
  });

  it('rejects a stale page whose card named a different runtime', async () => {
    const response = await request(app([CLAUDE_OLLAMA]))
      .post('/api/providers/readiness/setup?provider=claude-ollama&runtime=mtplx');

    expect(response.status).toBe(409);
    expect(setupService.runLocalRuntimeSetup).not.toHaveBeenCalled();
  });

  it('404s an unknown provider before opening a stream', async () => {
    const response = await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=nope');
    expect(response.status).toBe(404);
    expect(setupService.runLocalRuntimeSetup).not.toHaveBeenCalled();
  });

  it('400s a provider with no local daemon to set up', async () => {
    const response = await request(app([{ id: 'claude', command: 'claude', type: 'cli' }]))
      .post('/api/providers/readiness/setup?provider=claude');
    expect(response.status).toBe(400);
  });
});

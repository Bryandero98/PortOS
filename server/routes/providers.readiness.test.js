import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const readinessService = vi.hoisted(() => ({ getProviderReadinessMap: vi.fn() }));
vi.mock('../services/providerReadiness.js', () => readinessService);
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

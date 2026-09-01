import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import detectRoutes from './detect.js';

vi.mock('../services/aiDetect.js', () => ({
  detectAppWithAi: vi.fn()
}));

import { detectAppWithAi } from '../services/aiDetect.js';

describe('Detect Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/detect', detectRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
  });

  it('keeps an expected AI detection refusal as a structured 200 outcome', async () => {
    detectAppWithAi.mockResolvedValue({ success: false, error: 'No AI provider configured' });

    const response = await request(app)
      .post('/api/detect/ai')
      .send({ path: '/example/project' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: false, error: 'No AI provider configured' });
  });

  it('returns the standard error envelope when AI detection throws', async () => {
    detectAppWithAi.mockRejectedValue(new Error('provider crashed'));

    const response = await request(app)
      .post('/api/detect/ai')
      .send({ path: '/example/project' });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: 'provider crashed', code: 'INTERNAL_ERROR' });
    expect(response.body).not.toHaveProperty('success');
  });
});

// PORTOS_WORKSPACE_ROOTS is read once at module load, so these stub the env and
// re-import a fresh copy of the route graph. The module-registry reset drops the
// hoisted vi.mock above with it, so the AI service is re-mocked per load via
// vi.doMock (which applies to subsequent dynamic imports).
describe('POST /api/detect/ai workspace-root confinement', () => {
  let roots;
  let outside;

  const loadApp = async (workspaceRoots) => {
    vi.resetModules();
    vi.stubEnv('PORTOS_WORKSPACE_ROOTS', workspaceRoots);
    const detect = vi.fn();
    vi.doMock('../services/aiDetect.js', () => ({ detectAppWithAi: detect }));
    const routes = await import('./detect.js');
    const errors = await import('../lib/errorHandler.js');
    const scoped = express();
    scoped.use(express.json());
    scoped.use('/api/detect', routes.default);
    scoped.use(errors.errorMiddleware);
    return { app: scoped, detect };
  };

  beforeEach(() => {
    // realpathSync so macOS's /var -> /private/var symlink doesn't make the
    // configured root and the resolved request path disagree.
    roots = realpathSync(mkdtempSync(join(tmpdir(), 'portos-roots-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'portos-outside-')));
  });

  afterEach(() => {
    vi.doUnmock('../services/aiDetect.js');
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(roots, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a path outside the configured roots without invoking the provider', async () => {
    const { app: scoped, detect } = await loadApp(roots);

    const response = await request(scoped)
      .post('/api/detect/ai')
      .send({ path: outside });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE_ROOTS' });
    // The refusal must not echo the rejected filesystem path back to the caller.
    expect(JSON.stringify(response.body)).not.toContain(outside);
    // The regression this uniquely catches: no file was read and nothing was
    // shipped to a (possibly hosted) AI provider.
    expect(detect).not.toHaveBeenCalled();
  });

  it('allows a path inside the configured roots', async () => {
    const { app: scoped, detect } = await loadApp(roots);
    detect.mockResolvedValue({ success: true, app: { name: 'example' } });

    const response = await request(scoped)
      .post('/api/detect/ai')
      .send({ path: roots });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, app: { name: 'example' } });
    expect(detect).toHaveBeenCalledWith(roots, undefined);
  });

  it('stays unrestricted when PORTOS_WORKSPACE_ROOTS is unset', async () => {
    const { app: scoped, detect } = await loadApp('');
    detect.mockResolvedValue({ success: true, app: { name: 'example' } });

    const response = await request(scoped)
      .post('/api/detect/ai')
      .send({ path: outside });

    expect(response.status).toBe(200);
    expect(detect).toHaveBeenCalledWith(outside, undefined);
  });
});

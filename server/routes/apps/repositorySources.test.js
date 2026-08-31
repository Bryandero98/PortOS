import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import repositorySourceRoutes from './repositorySources.js';

vi.mock('../../services/apps.js', () => ({
  getAppById: vi.fn(),
}));
vi.mock('../../services/eidoverseRepositories.js', () => ({
  getEidoverseRepositorySources: vi.fn(),
  syncEidoverseWorldsFork: vi.fn(),
}));

import * as appsService from '../../services/apps.js';
import {
  getEidoverseRepositorySources,
  syncEidoverseWorldsFork,
} from '../../services/eidoverseRepositories.js';

describe('managed app repository sources routes', () => {
  let app;
  const managed = {
    id: 'app-eidoverse',
    name: 'Eidoverse Worlds',
    repoPath: '/example/worlds',
    pm2ProcessNames: ['eidoverse-worlds'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/apps', repositorySourceRoutes);
    appsService.getAppById.mockResolvedValue(managed);
  });

  it('returns the repository topology for the loaded app', async () => {
    getEidoverseRepositorySources.mockResolvedValue({
      kind: 'eidoverse',
      updatePullsBoth: true,
      sources: [{ id: 'worlds' }, { id: 'video' }],
    });

    const response = await request(app).get('/api/apps/app-eidoverse/repository-sources');

    expect(response.status).toBe(200);
    expect(getEidoverseRepositorySources).toHaveBeenCalledWith(managed);
    expect(response.body.sources).toHaveLength(2);
  });

  it('syncs only the configured Worlds fork', async () => {
    syncEidoverseWorldsFork.mockResolvedValue({
      synced: true,
      fullName: 'example-owner/eidoverse-worlds',
      source: 'anima-research/eidoverse-worlds',
      branch: 'main',
    });

    const response = await request(app)
      .post('/api/apps/app-eidoverse/repository-sources/sync-fork');

    expect(response.status).toBe(200);
    expect(syncEidoverseWorldsFork).toHaveBeenCalledWith(managed);
    expect(response.body).toMatchObject({ synced: true, branch: 'main' });
  });

  it('404s before inspecting repository sources for an unknown app', async () => {
    appsService.getAppById.mockResolvedValue(null);

    const response = await request(app).get('/api/apps/missing/repository-sources');

    expect(response.status).toBe(404);
    expect(getEidoverseRepositorySources).not.toHaveBeenCalled();
  });
});

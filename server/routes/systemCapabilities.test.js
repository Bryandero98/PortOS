import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mock = vi.hoisted(() => ({ detectSystemCapabilities: vi.fn() }));
vi.mock('../lib/systemCapabilities.js', () => mock);

const { default: routes } = await import('./systemCapabilities.js');

const app = express();
app.use('/api/system/capabilities', routes);
app.use(errorMiddleware);

describe('system capability routes', () => {
  it('returns the local capability snapshot without federation fields', async () => {
    mock.detectSystemCapabilities.mockResolvedValueOnce({
      version: 1,
      platform: 'darwin',
      arch: 'arm64',
      appleSilicon: true,
      cpuCount: 12,
      totalMemoryGb: 64,
      cuda: { status: 'absent', gpus: [], maxVramGb: null },
    });

    const response = await request(app).get('/api/system/capabilities');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      platform: 'darwin',
      appleSilicon: true,
      totalMemoryGb: 64,
      cuda: { status: 'absent' },
    });
    expect(response.body).not.toHaveProperty('hostname');
    expect(response.body).not.toHaveProperty('network');
  });
});

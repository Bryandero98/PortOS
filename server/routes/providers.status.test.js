import { describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';
import { createPortOSProviderRoutes } from './providers.js';

describe('PortOS provider status routes', () => {
  it('recovers the toolkit status instance used by run routing', async () => {
    const markAvailable = vi.fn(async () => ({ available: true, reason: 'ok' }));
    const toolkit = {
      services: {
        providers: {},
        providerStatus: { markAvailable }
      },
      routes: { providers: Router() }
    };
    const app = express();
    app.use(express.json());
    app.use('/api/providers', createPortOSProviderRoutes(toolkit));
    app.use(errorMiddleware);

    const response = await request(app).post('/api/providers/example-provider/status/recover');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      status: { available: true, reason: 'ok' }
    });
    expect(markAvailable).toHaveBeenCalledWith('example-provider');
  });
});

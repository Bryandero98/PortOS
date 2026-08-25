import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/portosProductMetrics.js', () => ({
  getDailyActions: vi.fn(),
}));

const svc = await import('../services/portosProductMetrics.js');
const { default: routes } = await import('./dashboardDailyActions.js');

const makeApp = () => {
  const app = express();
  app.use('/api/dashboard/daily-actions', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => vi.clearAllMocks());

describe('GET /api/dashboard/daily-actions', () => {
  it('returns the deterministic action projection', async () => {
    svc.getDailyActions.mockResolvedValue({ today: '2026-08-24', actions: [], metrics: {}, checkedAt: '2026-08-24T12:00:00.000Z' });
    const response = await request(makeApp()).get('/api/dashboard/daily-actions');
    expect(response.status).toBe(200);
    expect(response.body.today).toBe('2026-08-24');
    expect(svc.getDailyActions).toHaveBeenCalledOnce();
  });
});

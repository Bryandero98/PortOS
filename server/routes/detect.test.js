import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
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

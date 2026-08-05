import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/threejsModels/index.js', () => ({
  listModels: vi.fn(async () => []),
  getModel: vi.fn(),
  createModel: vi.fn(),
  startGeneration: vi.fn(),
  deleteModel: vi.fn(),
  getModelSource: vi.fn(),
}));

import * as models from '../services/threejsModels/index.js';
import routes from './threejsModels.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/threejs-models', routes);
  app.use(errorMiddleware);
  return app;
};

describe('Three.js model routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates and starts a gallery-backed model with an explicit assignment', async () => {
    models.createModel.mockResolvedValueOnce({ id: 'threejs-1', status: 'generating' });
    const res = await request(makeApp())
      .post('/api/threejs-models')
      .send({
        name: 'Example Robot',
        filename: 'robot.png',
        prompt: 'Keep the antenna articulated',
        providerId: 'codex',
        model: 'gpt-5',
      });
    expect(res.status).toBe(202);
    expect(models.createModel).toHaveBeenCalledWith({
      name: 'Example Robot',
      filename: 'robot.png',
      prompt: 'Keep the antenna articulated',
      providerId: 'codex',
      model: 'gpt-5',
    });
  });

  it('rejects paths masquerading as gallery filenames', async () => {
    const res = await request(makeApp())
      .post('/api/threejs-models')
      .send({ name: 'Bad', filename: '../secret.png', providerId: 'codex' });
    expect(res.status).toBe(400);
    expect(models.createModel).not.toHaveBeenCalled();
  });

  it('starts a refinement with bounded feedback', async () => {
    models.startGeneration.mockResolvedValueOnce({ id: 'threejs-1', status: 'generating' });
    const res = await request(makeApp())
      .post('/api/threejs-models/threejs-1/generate')
      .send({ providerId: 'ollama', model: 'qwen-vl', feedback: 'Make the handle thicker.' });
    expect(res.status).toBe(202);
    expect(models.startGeneration).toHaveBeenCalledWith('threejs-1', {
      providerId: 'ollama',
      model: 'qwen-vl',
      feedback: 'Make the handle thicker.',
    });
  });

  it('forwards a reasoning-effort override on generate and create', async () => {
    models.startGeneration.mockResolvedValueOnce({ id: 'threejs-1', status: 'generating' });
    const res = await request(makeApp())
      .post('/api/threejs-models/threejs-1/generate')
      .send({ providerId: 'antigravity-cli', model: 'gemini-3.6-flash', effort: 'high' });
    expect(res.status).toBe(202);
    expect(models.startGeneration).toHaveBeenCalledWith('threejs-1', {
      providerId: 'antigravity-cli',
      model: 'gemini-3.6-flash',
      effort: 'high',
      feedback: '',
    });

    models.createModel.mockResolvedValueOnce({ id: 'threejs-2', status: 'generating' });
    await request(makeApp())
      .post('/api/threejs-models')
      .send({ name: 'R', filename: 'r.png', providerId: 'antigravity-cli', model: 'gemini-3.6-flash', effort: 'low' });
    expect(models.createModel).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low' }));
  });

  it('maps the picker\'s empty "Default effort" to an explicit null clear', async () => {
    models.startGeneration.mockResolvedValueOnce({ id: 'threejs-1', status: 'generating' });
    const res = await request(makeApp())
      .post('/api/threejs-models/threejs-1/generate')
      .send({ providerId: 'antigravity-cli', effort: '' });
    expect(res.status).toBe(202);
    // `null` = clear, distinct from the key being absent (= keep what's stored).
    expect(models.startGeneration).toHaveBeenCalledWith('threejs-1', {
      providerId: 'antigravity-cli',
      effort: null,
      feedback: '',
    });
  });

  it('rejects an effort that is not a known level', async () => {
    const res = await request(makeApp())
      .post('/api/threejs-models/threejs-1/generate')
      .send({ providerId: 'antigravity-cli', effort: 'turbo' });
    expect(res.status).toBe(400);
    expect(models.startGeneration).not.toHaveBeenCalled();
  });

  it('serves generated source as a JavaScript attachment', async () => {
    models.getModelSource.mockResolvedValueOnce({
      filename: 'example-robot.js',
      source: 'export function createExampleRobotModel() {}',
    });
    const res = await request(makeApp()).get('/api/threejs-models/threejs-1/source');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['content-disposition']).toContain('example-robot.js');
    expect(res.text).toContain('createExampleRobotModel');
  });

  it('returns 404 for a missing model', async () => {
    models.getModel.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get('/api/threejs-models/missing');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

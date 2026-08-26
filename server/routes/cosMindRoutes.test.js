import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  readPersistentMindEvents: vi.fn(),
  loadState: vi.fn(),
  getPersistentMindState: vi.fn(),
  enqueuePersistentMindMessage: vi.fn(),
  appendPersistentMindAnnotation: vi.fn(),
  promotePersistentMindMemory: vi.fn(),
  startPersistentMind: vi.fn(),
  pausePersistentMind: vi.fn(),
  resumePersistentMind: vi.fn(),
  stopPersistentMind: vi.fn(),
}));

vi.mock('../services/agentRunEventLog.js', () => ({ readPersistentMindEvents: mocks.readPersistentMindEvents }));
vi.mock('../services/cosState.js', () => ({ loadState: mocks.loadState }));
vi.mock('../services/persistentMindContext.js', () => ({
  appendPersistentMindAnnotation: mocks.appendPersistentMindAnnotation,
  promotePersistentMindMemory: mocks.promotePersistentMindMemory,
}));
vi.mock('../services/persistentMindSupervisor.js', () => ({
  getPersistentMindState: mocks.getPersistentMindState,
  enqueuePersistentMindMessage: mocks.enqueuePersistentMindMessage,
  startPersistentMind: mocks.startPersistentMind,
  pausePersistentMind: mocks.pausePersistentMind,
  resumePersistentMind: mocks.resumePersistentMind,
  stopPersistentMind: mocks.stopPersistentMind,
}));

import cosMindRoutes from './cosMindRoutes.js';

const app = () => {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/cos', cosMindRoutes);
  instance.use(errorMiddleware);
  return instance;
};

const get = (path) => request(app()).get(`/api/cos${path}`);
const post = (path, body) => request(app()).post(`/api/cos${path}`).send(body);

describe('persistent mind routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readPersistentMindEvents.mockResolvedValue({ events: [], cursor: null, gap: false, hasMore: false, snapshot: {} });
    mocks.getPersistentMindState.mockResolvedValue({
      enabled: true, status: 'idle', started: false, queuedMessages: [{ id: 'private', text: 'must not leak' }],
      activeTurn: null, lastCompletedTurnId: null, lastCompletedAt: null, nextEligibleWakeAt: null,
      failureCount: 0, pauseReason: null, lastError: 'provider failed with \"apiKey\": \"secret-value\"',
    });
    mocks.loadState.mockResolvedValue({ config: { domainAutonomy: { cos: 'execute' }, persistentMindProfile: { enabled: true, providerId: 'demo', model: 'demo-model', effort: 'high' } } });
    mocks.enqueuePersistentMindMessage.mockResolvedValue({ success: true, duplicate: false, messageId: 'message-1' });
    mocks.appendPersistentMindAnnotation.mockResolvedValue({ appended: true, duplicate: false });
    mocks.promotePersistentMindMemory.mockResolvedValue({ success: true, memory: { id: 'memory-1' } });
    mocks.startPersistentMind.mockResolvedValue({ success: true });
    mocks.pausePersistentMind.mockResolvedValue({ success: true });
    mocks.resumePersistentMind.mockResolvedValue({ success: true });
    mocks.stopPersistentMind.mockResolvedValue({ success: true });
  });

  it('serves a bounded cursor snapshot with only the safe profile fields', async () => {
    const res = await get('/mind?cursor=12%3Amind-message%3Aone&limit=25');
    expect(res.status).toBe(200);
    expect(mocks.readPersistentMindEvents).toHaveBeenCalledWith({ mindId: 'cos-persistent-mind', cursor: '12:mind-message:one', limit: 25 });
    expect(res.body).toMatchObject({
      events: [], gap: false, state: { status: 'idle' },
      profile: { enabled: true, providerId: 'demo', model: 'demo-model', effort: 'high', thinkingInterface: 'text' },
      autonomyMode: 'execute',
    });
    expect(res.body.profile).not.toHaveProperty('credential');
    expect(res.body.state).not.toHaveProperty('queuedMessages');
    expect(res.body.state.queuedMessageCount).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
  });

  it('rejects malformed cursors, oversized pages, and unknown query fields', async () => {
    expect((await get('/mind?cursor=broken')).status).toBe(400);
    expect((await get('/mind?limit=501')).status).toBe(400);
    expect((await get('/mind?secret=1')).status).toBe(400);
    expect(mocks.readPersistentMindEvents).not.toHaveBeenCalled();
  });

  it('passes the caller id through so a retried message is idempotent', async () => {
    const first = await post('/mind/messages', { id: 'message-1', text: 'Consider the next bounded slice.' });
    mocks.enqueuePersistentMindMessage.mockResolvedValue({ success: true, duplicate: true, messageId: 'message-1' });
    const retry = await post('/mind/messages', { id: 'message-1', text: 'Consider the next bounded slice.' });

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retry.body.duplicate).toBe(true);
    expect(mocks.enqueuePersistentMindMessage).toHaveBeenNthCalledWith(2, { id: 'message-1', text: 'Consider the next bounded slice.' });
  });

  it('validates annotation targets and lifecycle inputs', async () => {
    expect((await post('/mind/annotations', { id: '', text: 'Idea' })).status).toBe(400);
    expect((await post('/mind/annotations', { id: 'annotation-1', text: 'Idea', extra: true })).status).toBe(400);
    expect((await post('/mind/pause', { reason: '' })).status).toBe(400);

    const accepted = await post('/mind/annotations', {
      id: 'annotation-1', text: 'Keep this as context.', turnId: 'turn-1', targetEventId: 'event-1',
    });
    expect(accepted.status).toBe(202);
    expect(mocks.appendPersistentMindAnnotation).toHaveBeenCalledWith({
      id: 'annotation-1', text: 'Keep this as context.', turnId: 'turn-1', targetEventId: 'event-1',
    });
  });

  it('projects lifecycle state instead of returning queued message bodies', async () => {
    mocks.pausePersistentMind.mockResolvedValue({
      success: true,
      state: {
        enabled: true, started: true, status: 'paused', queuedMessages: [{ id: 'private', text: 'must not leak' }],
        pauseReason: 'Paused from Mind page', activeTurn: null, failureCount: 0,
      },
    });
    const res = await post('/mind/pause', { reason: 'Paused from Mind page' });
    expect(res.status).toBe(200);
    expect(res.body.state).toMatchObject({ status: 'paused', queuedMessageCount: 1 });
    expect(JSON.stringify(res.body)).not.toContain('must not leak');
  });

  it('fails visibly when the supervisor refuses a lifecycle transition', async () => {
    mocks.startPersistentMind.mockResolvedValue({ success: false, error: 'Persistent mind is disabled' });
    const res = await post('/mind/start');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Persistent mind is disabled');
  });

  it('requires explicit approval before promoting a redacted event summary', async () => {
    expect((await post('/mind/events/event-1/promote', { id: 'promotion-1', approved: false, content: 'Safe summary' })).status).toBe(400);
    const res = await post('/mind/events/event-1/promote', {
      id: 'promotion-1', approved: true, content: 'Safe summary', type: 'insight', category: 'other',
    });
    expect(res.status).toBe(201);
    expect(mocks.promotePersistentMindMemory).toHaveBeenCalledWith(expect.objectContaining({
      approved: true, content: 'Safe summary', sourceEventId: 'event-1',
    }));
  });
});

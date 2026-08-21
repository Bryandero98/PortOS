import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./apiCore.js', () => ({
  request: vi.fn(),
}));

let request;
let api;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  api = await import('./apiFableLoom.js');
  request.mockReset();
  request.mockResolvedValue({});
});

describe('apiFableLoom', () => {
  it('encodes ids in nested node paths', async () => {
    await api.updateLoomNode('loom/1', 'ep/1', 'node/1', { prose: 'x' }, { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom%2F1/episodes/ep%2F1/nodes/node%2F1', {
      method: 'PATCH',
      body: JSON.stringify({ prose: 'x' }),
      silent: true,
    });
  });

  it('posts weave options to the episode weave lane', async () => {
    await api.weaveLoomEpisode('loom-1', 'ep-1', { guidance: 'darker', replace: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/weave', {
      method: 'POST',
      body: JSON.stringify({ guidance: 'darker', replace: true }),
    });
  });

  it('posts play turns with the transcript', async () => {
    const body = { nodeId: 'node-1', message: 'open the gate', transcript: [] };
    await api.playLoomTurn('loom-1', 'ep-1', body);
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/play', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('reads validation silently for the polling panel', async () => {
    await api.validateLoomEpisode('loom-1', 'ep-1', { silent: true });
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/validate', { silent: true });
  });

  it('deletes nodes with DELETE', async () => {
    await api.deleteLoomNode('loom-1', 'ep-1', 'node-1');
    expect(request).toHaveBeenCalledWith('/fableloom/loom-1/episodes/ep-1/nodes/node-1', { method: 'DELETE' });
  });
});

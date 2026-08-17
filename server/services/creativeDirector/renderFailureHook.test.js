import { afterEach, describe, expect, it, vi } from 'vitest';

const queueCreativeDirectorRenderFailureTask = vi.fn(() => Promise.resolve({ id: 'sys-repair-1' }));
vi.mock('./renderFailureTask.js', () => ({ queueCreativeDirectorRenderFailureTask }));

const { mediaJobEvents } = await import('../mediaJobQueue/index.js');
const { initCreativeDirectorRenderFailureHook, __testing } = await import('./renderFailureHook.js');

afterEach(() => {
  __testing.reset();
  queueCreativeDirectorRenderFailureTask.mockClear();
});

describe('Creative Director render failure hook', () => {
  it('queues a repair task for tagged scene and project-level jobs', async () => {
    initCreativeDirectorRenderFailureHook();
    mediaJobEvents.emit('failed', {
      id: 'job-scene', error: 'bad frames',
      params: { creativeDirector: { projectId: 'project-1', sceneId: 'scene-2' } },
    });
    mediaJobEvents.emit('failed', {
      id: 'job-music', error: 'bad audio',
      params: { creativeDirectorMusicBed: { projectId: 'project-2' } },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(queueCreativeDirectorRenderFailureTask).toHaveBeenCalledTimes(2);
    expect(queueCreativeDirectorRenderFailureTask).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1', sceneId: 'scene-2', jobId: 'job-scene', error: 'bad frames',
    });
    expect(queueCreativeDirectorRenderFailureTask).toHaveBeenNthCalledWith(2, {
      projectId: 'project-2', sceneId: null, jobId: 'job-music', error: 'bad audio',
    });
  });

  it('ignores failures from unrelated media jobs', async () => {
    initCreativeDirectorRenderFailureHook();
    mediaJobEvents.emit('failed', { id: 'job-other', error: 'not CD', params: { prompt: 'plain render' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(queueCreativeDirectorRenderFailureTask).not.toHaveBeenCalled();
  });
});

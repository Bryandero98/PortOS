import { describe, expect, it } from 'vitest';
import { buildCreativeDirectorRenderFailureTask } from './renderFailureTask.js';

describe('buildCreativeDirectorRenderFailureTask', () => {
  it('creates a deduplicable internal repair task with bounded failure context', () => {
    const task = buildCreativeDirectorRenderFailureTask({
      projectId: 'project-1', sceneId: 'scene-2', jobId: 'job-3',
      error: 'MiniMax H3 requires a 17n+5 frame count between 107 and 362; got 304',
    });
    expect(task).toMatchObject({
      description: 'Creative Director render failure: fix project project-1 scene scene-2',
      priority: 'HIGH', useWorktree: true, openPR: true, simplify: true, isRecovery: true,
      diagnostics: {
        triggerEvent: 'CREATIVE_DIRECTOR_RENDER_FAILED',
        target: 'creativeDirector/renderFailureHook',
        failureReason: 'MiniMax H3 requires a 17n+5 frame count between 107 and 362; got 304',
      },
    });
    expect(task.context).toContain('Media job: job-3');
  });

  it('truncates provider errors before persisting them in a task', () => {
    const task = buildCreativeDirectorRenderFailureTask({ projectId: 'project-1', sceneId: 'scene-2', error: 'x'.repeat(3000) });
    expect(task.diagnostics.failureReason).toHaveLength(2000);
    expect(task.context).toContain(`Renderer error: ${'x'.repeat(2000)}`);
  });
});

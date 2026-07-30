/**
 * prepareGenerateParams — Music Video render-target resolution (#3231 Phase 4).
 *
 * Scene reference-frame renders arrive with a `musicVideo` tag and NO mode, so
 * the mode must come from the render-target ladder (record pin →
 * renderDefaults['music-video'] → install default) and the layered model must
 * land on `data.cloudModel`, which is what the route's dispatch resolution
 * reads. Only the ladder inputs are mocked; the resolver itself runs for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSettings = vi.fn(async () => ({}));
vi.mock('../settings.js', () => ({ getSettings: (...a) => getSettings(...a) }));

const getProject = vi.fn(async () => null);
vi.mock('../musicVideo/projects.js', () => ({ getProject: (...a) => getProject(...a) }));

const { prepareGenerateParams } = await import('./prepareParams.js');

const CODEX_ON = { codex: { enabled: true, codexPath: '/bin/codex' } };
const run = (data) => prepareGenerateParams({ data, files: undefined, referenceImageFields: [] });

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
  getProject.mockResolvedValue(null);
});

describe('music-video render-target resolution (#3231 Phase 4)', () => {
  it('resolves the owning project record pin and stamps its model onto cloudModel', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', ...CODEX_ON } });
    getProject.mockResolvedValue({ id: 'mv-1', imageMode: 'codex', imageModelId: 'record-model' });
    const { data, mode } = await run({ prompt: 'p', musicVideo: { projectId: 'mv-1', sceneId: 's1' } });
    expect(getProject).toHaveBeenCalledWith('mv-1');
    expect(mode).toBe('codex');
    expect(data.cloudModel).toBe('record-model');
  });

  it("resolves renderDefaults['music-video'] when the record has no pin", async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'local', ...CODEX_ON },
      renderDefaults: { 'music-video': { imageMode: 'codex', imageModel: 'target-model' } },
    });
    getProject.mockResolvedValue({ id: 'mv-1' });
    const { data, mode } = await run({ prompt: 'p', musicVideo: { projectId: 'mv-1', sceneId: 's1' } });
    expect(mode).toBe('codex');
    expect(data.cloudModel).toBe('target-model');
  });

  it('an explicit request mode outranks the record pin (and its model does not leak)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external', ...CODEX_ON } });
    getProject.mockResolvedValue({ id: 'mv-1', imageMode: 'codex', imageModelId: 'record-model' });
    const { data, mode } = await run({ prompt: 'p', mode: 'local', musicVideo: { projectId: 'mv-1', sceneId: 's1' } });
    expect(mode).toBe('local');
    expect(data.cloudModel).toBeUndefined();
    // Explicit mode wins outright, so the project store isn't even consulted.
    expect(getProject).not.toHaveBeenCalled();
  });

  it('falls through to the install default with no pins, and a missing project is harmless', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    getProject.mockRejectedValue(new Error('gone'));
    const { mode } = await run({ prompt: 'p', musicVideo: { projectId: 'mv-x', sceneId: 's1' } });
    expect(mode).toBe('external');
  });

  it('renders without a musicVideo tag never touch the project store', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    const { mode } = await run({ prompt: 'p' });
    expect(mode).toBe('external');
    expect(getProject).not.toHaveBeenCalled();
  });
});

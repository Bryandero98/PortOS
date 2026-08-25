/**
 * prepareGenerateParams — record render-target resolution (#3231 Phase 4).
 *
 * Scene reference-frame renders (`musicVideo` tag) and universe canon renders
 * (`universeRun` tag) can arrive with NO mode, so the mode must come from the
 * render-target ladder (record pin → renderDefaults[target] → install default)
 * and the layered model must land on `data.cloudModel`, which is what the
 * route's dispatch resolution reads. Only the ladder inputs are mocked; the
 * resolver itself runs for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSettings = vi.fn(async () => ({}));
vi.mock('../settings.js', () => ({ getSettings: (...a) => getSettings(...a) }));

const getProject = vi.fn(async () => null);
vi.mock('../musicVideo/projects.js', () => ({ getProject: (...a) => getProject(...a) }));

const getUniverseRenderPin = vi.fn(async () => null);
vi.mock('../universeBuilder/crud.js', () => ({ getUniverseRenderPin: (...a) => getUniverseRenderPin(...a) }));

const { prepareGenerateParams, selectLocalImageModel } = await import('./prepareParams.js');

const CODEX_ON = { codex: { enabled: true, codexPath: '/bin/codex' } };
const run = (data) => prepareGenerateParams({ data, files: undefined, referenceImageFields: [] });

describe('selectLocalImageModel', () => {
  it('keeps an explicit model pin', () => {
    const models = [
      { id: 'dev', hardwareCompatibility: { state: 'unavailable' } },
      { id: 'custom', hardwareCompatibility: { state: 'available' } },
    ];
    expect(selectLocalImageModel('custom', models).id).toBe('custom');
  });

  it('falls back from an unavailable dev default to a compatible model', () => {
    const models = [
      { id: 'dev', hardwareCompatibility: { state: 'unavailable' } },
      { id: 'custom', hardwareCompatibility: { state: 'available' } },
    ];
    expect(selectLocalImageModel(undefined, models).id).toBe('custom');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue({});
  getProject.mockResolvedValue(null);
  getUniverseRenderPin.mockResolvedValue(null);
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

describe('universe render-target resolution', () => {
  const AGY_ON = { agy: { enabled: true, agyPath: '/bin/agy' } };
  const tag = { universeId: 'uni-1', universeName: 'Example Universe', category: 'characters' };

  it("resolves the owning universe's record pin for a mode-less canon render", async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', ...AGY_ON } });
    getUniverseRenderPin.mockResolvedValue({ id: 'uni-1', imageMode: 'agy', imageModelId: 'record-model' });
    const { data, mode } = await run({ prompt: 'p', universeRun: tag });
    expect(getUniverseRenderPin).toHaveBeenCalledWith('uni-1');
    expect(mode).toBe('agy');
    expect(data.cloudModel).toBe('record-model');
  });

  it("resolves renderDefaults['universe-bible'] when the universe has no pin", async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'local', ...AGY_ON },
      renderDefaults: { 'universe-bible': { imageMode: 'agy', imageModel: 'target-model' } },
    });
    getUniverseRenderPin.mockResolvedValue({ id: 'uni-1' });
    const { data, mode } = await run({ prompt: 'p', universeRun: tag });
    expect(mode).toBe('agy');
    expect(data.cloudModel).toBe('target-model');
  });

  it('an explicit request mode outranks the universe pin (and its model does not leak)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external', ...AGY_ON } });
    getUniverseRenderPin.mockResolvedValue({ id: 'uni-1', imageMode: 'agy', imageModelId: 'record-model' });
    const { data, mode } = await run({ prompt: 'p', mode: 'local', universeRun: tag });
    expect(mode).toBe('local');
    expect(data.cloudModel).toBeUndefined();
    expect(getUniverseRenderPin).not.toHaveBeenCalled();
  });

  it('falls through to the install default when the universe is gone', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    getUniverseRenderPin.mockRejectedValue(new Error('gone'));
    const { mode } = await run({ prompt: 'p', universeRun: { ...tag, universeId: 'uni-x' } });
    expect(mode).toBe('external');
  });

  it('renders without a universeRun tag never touch the universe store', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    await run({ prompt: 'p' });
    expect(getUniverseRenderPin).not.toHaveBeenCalled();
  });

  // Two tags on one payload used to run BOTH branches: the second overwrote the
  // first's mode while inheriting the model it had just stamped, producing a
  // mismatched mode/model pair and a wasted record read.
  it('resolves the first matching tag only when a payload carries two', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', ...AGY_ON, codex: { enabled: true } } });
    getProject.mockResolvedValue({ id: 'mv-1', imageMode: 'codex', imageModelId: 'mv-model' });
    getUniverseRenderPin.mockResolvedValue({ imageMode: 'agy', imageModelId: 'uni-model' });
    const { data, mode } = await run({
      prompt: 'p', musicVideo: { projectId: 'mv-1', sceneId: 's1' }, universeRun: tag,
    });
    expect(mode).toBe('codex');
    expect(data.cloudModel).toBe('mv-model');
    expect(getUniverseRenderPin).not.toHaveBeenCalled();
  });
});

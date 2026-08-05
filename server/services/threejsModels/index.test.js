import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  resolveGalleryImage: vi.fn((filename) => (
    filename === 'missing.png' ? null : `/mock/data/images/${filename}`
  )),
}));

vi.mock('../../lib/promptRunner.js', () => ({
  runPromptThroughProvider: vi.fn(),
}));

vi.mock('../providers.js', () => ({
  getProviderById: vi.fn(),
}));

vi.mock('./db.js', () => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  mutateModel: vi.fn(),
  deleteModel: vi.fn(),
  recoverInterruptedModels: vi.fn(),
}));

import { runPromptThroughProvider } from '../../lib/promptRunner.js';
import { getProviderById } from '../providers.js';
import * as store from './db.js';
import { createModel, startGeneration } from './index.js';

const spec = {
  schemaVersion: 1,
  name: 'Example Beacon',
  summary: 'A compact beacon with a separate glowing lens.',
  subjectType: 'object',
  background: '#111827',
  camera: { position: [3, 2, 4] },
  materials: {
    body: { color: '#334155' },
    lens: { color: '#38bdf8', emissive: '#38bdf8', emissiveIntensity: 2 },
  },
  lights: [{ type: 'directional', intensity: 2 }],
  parts: [{
    id: 'body',
    name: 'Body',
    geometry: { type: 'cylinder', radiusTop: 0.5, radiusBottom: 0.7, height: 1.5 },
    material: 'body',
    children: [{
      id: 'lens',
      name: 'Lens',
      geometry: { type: 'sphere', radius: 0.35 },
      material: 'lens',
    }],
  }],
  detailInventory: [{
    feature: 'Glowing lens',
    evidence: 'A bright cyan lens caps the reference object.',
    implementationPartIds: ['lens'],
    priority: 'identity',
  }],
};

describe('Three.js model generation orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderById.mockResolvedValue({
      id: 'vision-api',
      name: 'Vision API',
      type: 'api',
      enabled: true,
      defaultModel: 'vision-default',
    });
  });

  it('rejects a source that is no longer in the MediaGen gallery', async () => {
    await expect(createModel({
      name: 'Missing',
      filename: 'missing.png',
      providerId: 'vision-api',
    })).rejects.toMatchObject({ status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
    expect(store.createModel).not.toHaveBeenCalled();
  });

  it('rejects a duplicate request while the model is generating', async () => {
    store.getModel.mockResolvedValue({
      id: 'threejs-busy',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      status: 'generating',
      generationOperationId: 'active-operation',
    });

    await expect(startGeneration('threejs-busy', {
      providerId: 'vision-api',
    })).rejects.toMatchObject({ status: 409, code: 'MODEL_BUSY' });
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('attaches the image for API providers and persists validated output', async () => {
    let current = {
      id: 'threejs-example',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'vision-api',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      runs: [],
    };
    store.getModel.mockResolvedValue(current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(spec),
      runId: 'run-example',
      provider: { id: 'vision-api' },
      model: 'vision-pro',
    });

    const started = await startGeneration(current.id, {
      providerId: 'vision-api',
      model: 'vision-pro',
      prompt: 'Preserve the glowing lens.',
    });

    expect(started.status).toBe('generating');
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/mock/data',
      model: 'vision-pro',
      screenshots: ['/mock/data/images/example.png'],
      source: 'threejs-model-generation',
    }));
    expect(current.spec.name).toBe('Example Beacon');
    expect(current.runs.at(-1)).toMatchObject({
      status: 'completed',
      runId: 'run-example',
      providerId: 'vision-api',
      model: 'vision-pro',
    });
  });

  it('gives CLI agents a gallery path without passing an API attachment', async () => {
    getProviderById.mockResolvedValue({
      id: 'local-agent',
      name: 'Local Agent',
      type: 'cli',
      enabled: true,
    });
    let current = {
      id: 'threejs-cli',
      name: 'Example Beacon',
      sourceImage: { filename: 'example.png' },
      providerId: 'local-agent',
      model: null,
      prompt: '',
      status: 'draft',
      spec: null,
      runs: [],
    };
    store.getModel.mockResolvedValue(current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });
    runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(spec),
      runId: 'run-cli',
      provider: { id: 'local-agent' },
      model: null,
    });

    await startGeneration(current.id, { providerId: 'local-agent' });
    await vi.waitFor(() => expect(current.status).toBe('ready'));
    expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/mock/data',
      screenshots: [],
      prompt: expect.stringContaining('/mock/data/images/example.png'),
    }));
  });

  describe('effort threading', () => {
    // A CLI provider whose CLI has an effort knob (`agy --effort <level>`).
    const agyProvider = {
      id: 'antigravity-cli',
      name: 'Antigravity',
      type: 'cli',
      enabled: true,
      command: 'agy',
    };

    const primeRecord = (overrides = {}) => {
      let current = {
        id: 'threejs-effort',
        name: 'Example Beacon',
        sourceImage: { filename: 'example.png' },
        providerId: 'antigravity-cli',
        model: 'gemini-3.6-flash',
        prompt: '',
        status: 'draft',
        spec: null,
        runs: [],
        ...overrides,
      };
      store.getModel.mockResolvedValue(current);
      store.mutateModel.mockImplementation(async (_id, mutate) => {
        const next = mutate(current);
        if (next) current = next;
        return current;
      });
      runPromptThroughProvider.mockResolvedValue({
        text: JSON.stringify(spec),
        runId: 'run-effort',
        provider: { id: 'antigravity-cli' },
        model: 'gemini-3.6-flash',
      });
      return () => current;
    };

    it('forwards the selected effort to the prompt runner and persists it', async () => {
      getProviderById.mockResolvedValue(agyProvider);
      const read = primeRecord();

      await startGeneration('threejs-effort', {
        providerId: 'antigravity-cli',
        model: 'gemini-3.6-flash',
        effort: 'high',
      });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }));
      expect(read().effort).toBe('high');
      expect(read().runs.at(-1)).toMatchObject({ effort: 'high' });
    });

    it('keeps the stored effort when the caller omits the key entirely', async () => {
      getProviderById.mockResolvedValue(agyProvider);
      const read = primeRecord({ effort: 'medium' });

      await startGeneration('threejs-effort', { providerId: 'antigravity-cli' });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: 'medium' }));
      expect(read().effort).toBe('medium');
    });

    it('drops an effort the resolved provider/model cannot honor instead of persisting a lie', async () => {
      // The picker hides the effort control for a provider with no tiers but
      // keeps its last value, so the request can still carry one.
      getProviderById.mockResolvedValue({
        id: 'vision-api', name: 'Vision API', type: 'api', enabled: true, defaultModel: 'vision-default',
      });
      const read = primeRecord({ providerId: 'vision-api' });

      await startGeneration('threejs-effort', { providerId: 'vision-api', model: 'vision-pro', effort: 'high' });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: undefined }));
      expect(read().effort).toBeNull();
    });

    it('persists the CLAMPED effort when the chosen agy model lacks that tier', async () => {
      getProviderById.mockResolvedValue({
        ...agyProvider,
        models: ['gemini-3.1-pro-low', 'gemini-3.1-pro-high'],
      });
      const read = primeRecord({ model: 'gemini-3.1-pro' });

      // agy rejects `--model gemini-3.1-pro --effort medium`, so it runs as low.
      await startGeneration('threejs-effort', {
        providerId: 'antigravity-cli', model: 'gemini-3.1-pro', effort: 'medium',
      });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low' }));
      expect(read().effort).toBe('low');
    });

    it('clears the stored effort on an explicit null (the picker\'s "Default effort")', async () => {
      getProviderById.mockResolvedValue(agyProvider);
      const read = primeRecord({ effort: 'medium' });

      await startGeneration('threejs-effort', { providerId: 'antigravity-cli', effort: null });

      await vi.waitFor(() => expect(read().status).toBe('ready'));
      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ effort: undefined }));
      expect(read().effort).toBeNull();
    });
  });
});

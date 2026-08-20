import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { routedJobParams } from './routedJobParams.js';

const PEER_ID = '00000000-0000-4000-8000-0000000004f1';

const remoteMedia = {
  wireVersion: 1,
  peerId: PEER_ID,
  reconcile: false,
  cancelRequested: false,
  request: {
    kind: 'image',
    engine: 'local',
    modelId: 'dev',
    prompt: 'a lighthouse at dusk',
    width: 512,
    height: 512,
  },
};

describe('routedJobParams', () => {
  it('nulls every top-level field a local dispatcher would render from', () => {
    const params = routedJobParams({
      params: { prompt: 'a lighthouse at dusk', modelId: 'dev', width: 512, height: 512 },
      remoteMedia,
    });

    expect(params.prompt).toBe('');
    // `null`, NOT absent — generateImage/generateVideo declare `modelId` as a
    // default parameter, which fires on `undefined` only. `toBeNull` is the
    // assertion that distinguishes the two.
    expect(params.modelId).toBeNull();
    expect(params.pythonPath).toBeNull();
  });

  it('keeps the versioned marker and the destination tags a completion hook needs', () => {
    const params = routedJobParams({
      params: { universeRun: 'run-1', catalogAttach: true, width: 512 },
      remoteMedia,
    });

    expect(params.remoteMedia).toEqual(remoteMedia);
    expect(params.universeRun).toBe('run-1');
    expect(params.catalogAttach).toBe(true);
    expect(params.width).toBe(512);
  });

  it('still produces the guarded shape when the caller passes no params at all', () => {
    // The video route routes without carrying any surviving job params.
    const params = routedJobParams({ remoteMedia });

    expect(params).toEqual({ prompt: '', modelId: null, pythonPath: null, remoteMedia });
  });

  it('defaults the marker off params, which is how enqueueJob calls it', () => {
    const params = routedJobParams({ params: { modelId: 'dev', prompt: 'edited', remoteMedia } });

    expect(params.remoteMedia).toEqual(remoteMedia);
    expect(params.prompt).toBe('');
    expect(params.modelId).toBeNull();
  });
});

// The point of the shape above: a machine rolled back to a build that predates
// `remoteMedia` ignores the marker and dispatches the job to its LOCAL renderer.
// These feed the routed params straight to the real local entry points — the
// surface a legacy dispatcher would land on — and assert they refuse.
describe('downgrade to a pre-remoteMedia build', () => {
  let tmpRegistryDir;
  let priorRegistryEnv;
  let generateImage;
  let generateVideo;
  let getImageModels;
  let LOCAL_IMAGEGEN_DEFAULT_MODEL;

  beforeAll(async () => {
    // Same guard local.test.js uses: point the model registry at a temp file so
    // the seed-on-read path can't write into the repo's data dir.
    tmpRegistryDir = mkdtempSync(join(tmpdir(), 'portos-routed-params-test-'));
    priorRegistryEnv = process.env.PORTOS_MEDIA_MODELS_FILE;
    process.env.PORTOS_MEDIA_MODELS_FILE = join(tmpRegistryDir, 'media-models.json');
    vi.resetModules();
    ({ generateImage } = await import('../imageGen/local.js'));
    ({ generateVideo } = await import('../videoGen/local.js'));
    ({ getImageModels } = await import('../../lib/mediaModels.js'));
    ({ LOCAL_IMAGEGEN_DEFAULT_MODEL } = await import('../imageGen/modes.js'));
  });

  afterAll(() => {
    if (priorRegistryEnv === undefined) delete process.env.PORTOS_MEDIA_MODELS_FILE;
    else process.env.PORTOS_MEDIA_MODELS_FILE = priorRegistryEnv;
    rmSync(tmpRegistryDir, { recursive: true, force: true });
  });

  // Bypass probe for the two guards below — without it they could pass for the
  // wrong reason. The shipped default model IS registered, so the "just delete
  // the modelId key" variant of this fix would have resolved a real model and
  // rendered for real wherever its weights are installed. That is precisely why
  // the routed params carry an explicit `null` instead of dropping the key.
  it('would have resolved the shipped default if modelId were merely absent', () => {
    expect(getImageModels().map((m) => m.id)).toContain(LOCAL_IMAGEGEN_DEFAULT_MODEL);
  });

  it('refuses a routed image job — generateImage permits a blank prompt, so the model guard is the one that fires', async () => {
    const params = routedJobParams({
      params: { width: 512, height: 512, seed: 42 },
      remoteMedia,
    });

    await expect(generateImage(params)).rejects.toThrow(/Unknown or unsupported model/);
  });

  it('refuses a routed video job on the prompt guard, and on the model guard behind it', async () => {
    const params = routedJobParams({ remoteMedia });

    await expect(generateVideo(params)).rejects.toThrow(/Prompt is required/);
    // Second, independent guard: even a build whose prompt check ever loosened
    // has nothing to render with.
    await expect(generateVideo({ ...params, prompt: 'a lighthouse at dusk' }))
      .rejects.toThrow(/Unknown video model/);
  });
});

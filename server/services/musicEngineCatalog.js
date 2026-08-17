/**
 * Live music-engine catalog shared by the Music UI and scheduled commissions.
 * A commission resolves its configured engine/model at fire time so a runtime
 * removed after configuration records an explicit skip instead of silently
 * falling back to a different renderer.
 */

import {
  ENGINES, DEFAULT_ENGINE_ID, getEngineModel, isEngineHealthy,
  isEnginePlatformSupported, enginePlatformLabel,
} from './pipeline/musicGen.js';
import { listEngineModels } from './audioModels.js';
import { inspectModelCache } from '../lib/hfCache.js';
import { getCudaCapability } from '../lib/cudaCapability.js';

export async function listMusicEngineCatalog() {
  const cuda = await getCudaCapability();
  const engines = await Promise.all(Object.values(ENGINES).map(async (engine) => {
    const fixedModel = engine.fixedModelInstall ? getEngineModel(engine.id, engine.defaultModelId) : null;
    const modelCache = fixedModel ? await inspectModelCache(fixedModel.repo).catch(() => ({ cached: false })) : null;
    const runtimeReady = await isEngineHealthy(engine.id);
    const platformSupported = isEnginePlatformSupported(engine.id);
    return {
      id: engine.id,
      name: engine.name,
      models: await listEngineModels(engine.id),
      defaultModelId: engine.defaultModelId,
      minDurationSec: engine.minDurationSec,
      maxDurationSec: engine.maxDurationSec,
      defaultDurationSec: engine.defaultDurationSec,
      lyrics: engine.lyrics === true,
      autoDuration: engine.autoDuration === true,
      customModels: engine.customModels === true,
      fixedModelInstall: engine.fixedModelInstall === true,
      modelReady: modelCache ? modelCache.cached === true : true,
      modelSizeGb: fixedModel?.downloadSizeGb ?? null,
      runtimeReady,
      cudaRequired: engine.cudaRequired === true,
      platformSupported,
      platformLabel: enginePlatformLabel(engine.id),
      cudaState: engine.cudaRequired ? cuda.status : 'available',
      ready: platformSupported && runtimeReady && (!engine.cudaRequired || cuda.status === 'available') && (!modelCache || modelCache.cached === true),
      installEnv: engine.installEnv,
      venvDefault: engine.venvDefault,
    };
  }));
  return { engines, defaultEngine: DEFAULT_ENGINE_ID };
}

export async function resolveMusicEngineSelection({ engineId, modelId } = {}) {
  const catalog = await listMusicEngineCatalog();
  const selectedEngineId = engineId || catalog.defaultEngine;
  const engine = catalog.engines.find((entry) => entry.id === selectedEngineId);
  if (!engine || !engine.ready) {
    return { status: 'unavailable', reason: 'music-engine-unavailable' };
  }
  const selectedModelId = modelId || engine.defaultModelId;
  const model = engine.models.find((entry) => entry.id === selectedModelId);
  if (!model) return { status: 'unavailable', reason: 'music-model-unavailable' };
  return {
    status: 'ready',
    selection: {
      engine: engine.id,
      modelId: model.id,
      repo: model.repo,
    },
  };
}

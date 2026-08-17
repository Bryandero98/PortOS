/**
 * One authoritative view of the music engines this install can actually run.
 *
 * The Music UI and the federated-media provider both consume this projection.
 * Keeping runtime, platform, fixed-model, and CUDA readiness in one place is
 * important: a provider must never advertise work that the local UI would
 * correctly reject, especially when CUDA probing returned `unknown`.
 */

import { inspectModelCache } from '../lib/hfCache.js';
import { getCudaCapability } from '../lib/cudaCapability.js';
import {
  ENGINES,
  DEFAULT_ENGINE_ID,
  getEngineModel,
  isEngineHealthy,
  isEnginePlatformSupported,
  enginePlatformLabel,
  resolveEngineVramReadiness,
} from './pipeline/musicGen.js';
import { listEngineModels } from './audioModels.js';

export async function listMusicEngineCapabilities() {
  const cuda = await getCudaCapability();
  const engines = await Promise.all(Object.values(ENGINES).map(async (engine) => {
    const fixedModels = engine.fixedModelInstall ? engine.models : [];
    const modelReadyById = engine.fixedModelInstall
      ? Object.fromEntries(await Promise.all(fixedModels.map(async (model) => [
        model.id,
        (await inspectModelCache(model.repo, { revision: model.revision }).catch(() => ({ cached: false }))).cached === true,
      ])))
      : null;
    // Preserve the aggregate for older clients, while newer consumers gate
    // the exact selected checkpoint through modelReadyById.
    const modelReady = modelReadyById ? Object.values(modelReadyById).some(Boolean) : true;
    const fixedModel = engine.fixedModelInstall
      ? getEngineModel(engine.id, engine.defaultModelId)
      : null;
    const modelSizeGbById = engine.fixedModelInstall
      ? Object.fromEntries(fixedModels.map((model) => [model.id, model.downloadSizeGb ?? null]))
      : null;
    const runtimeReady = await isEngineHealthy(engine.id);
    const cudaState = engine.cudaRequired ? cuda.status : 'available';
    const vram = resolveEngineVramReadiness(engine.id, cuda);

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
      modelReady,
      ...(modelReadyById ? { modelReadyById } : {}),
      modelSizeGb: fixedModel?.downloadSizeGb ?? null,
      ...(modelSizeGbById ? { modelSizeGbById } : {}),
      runtimeReady,
      cudaRequired: engine.cudaRequired === true,
      platformSupported: isEnginePlatformSupported(engine.id),
      platformLabel: enginePlatformLabel(engine.id),
      cudaState,
      executionProfile: vram.executionProfile,
      vramState: vram.state,
      vramProfileLabel: vram.profileLabel,
      minVramGb: vram.minVramGb,
      recommendedVramGb: vram.recommendedVramGb,
      maxVramGb: vram.maxVramGb,
      ready: runtimeReady
        && (!engine.cudaRequired || cudaState === 'available')
        && (!engine.cudaRequired || vram.state === 'sufficient')
        && modelReady,
      installEnv: engine.installEnv,
      venvDefault: engine.venvDefault,
    };
  }));

  return { engines, defaultEngine: DEFAULT_ENGINE_ID };
}

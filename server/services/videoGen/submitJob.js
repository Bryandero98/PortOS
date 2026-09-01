/**
 * Submit a validated video-generation request to its federated, Grok, or local
 * dispatch lane. HTTP parsing and validation stay in the route; this service
 * owns every subsequent orchestration and rollback decision.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { buildFederatedMediaRequest } from '../../lib/federatedMediaRequest.js';
import { asFableLoomRenderSettings } from '../../lib/fableLoomProduction.js';
import { isFullDecode } from '../../lib/videoDraftDecoders.js';
import { isDefaultI2vReferenceMode } from '../../lib/videoReferenceModes.js';
import { isDefaultSpeedProfile } from '../../lib/videoSpeedProfiles.js';
import { isStockTextEncoder } from '../../lib/videoTextEncoders.js';
import { collectRemoteInputAssets } from '../federatedMedia/inputAssets.js';
import { prepareRemoteMediaJob } from '../federatedMedia/remoteSubmission.js';
import { getLoom } from '../fableLoom/records.js';
import {
  compileFableLoomVisualRequest,
  fableLoomVideoCapabilities,
} from '../fableLoom/visualConditioning.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import {
  cleanupMultipartTemp,
  prepareVideoGenParams,
  withStagedRollback,
} from './prepareParams.js';

// These names mirror the route-owned Zod schema. The service needs only their
// names to decide whether a request can honor a Grok pin; it deliberately does
// not import HTTP validation back into the service layer.
const LOCAL_ONLY_VIDEO_PARAM_KEYS = [
  'numFrames',
  'fps',
  'steps',
  'guidanceScale',
  'seed',
  'imageStrength',
  'i2vReferenceMode',
  'tiling',
  'textEncoderId',
  'speedProfileId',
  'draftDecode',
];

const submitValidatedVideoGenJob = async (body, uploads) => {
  let fableLoomRenderSettings = null;
  if (body.fableLoom) {
    const taggedLoom = await getLoom(body.fableLoom.loomId);
    if (taggedLoom) {
      fableLoomRenderSettings = asFableLoomRenderSettings(taggedLoom.renderSettings);
      body.width = fableLoomRenderSettings.width;
      body.height = fableLoomRenderSettings.height;
    }
  }

  // Federated render (#4348): submit to the selected peer instead of running
  // locally. Handled before local preparation, which resolves this machine's
  // backend and stages uploads a remote render can never use.
  if (body.mediaProviderPeerId) {
    const unsupported = [
      ['uploaded files', Object.keys(uploads).length],
      ['keyframes', body.keyframes?.length],
      ['a source video to extend', body.extendFromVideoId],
      ['IC-LoRA references', body.icReferenceVideoIds?.length || body.icReferenceImageFiles?.length],
      ['LoRA weights', body.loraFilenames?.length],
      ['chained chunks', body.chunks > 1],
      ['the Grok backend', body.backend === 'grok'],
      ['a FableLoom scene tag', body.fableLoom],
      ['a loose reference mode', !isDefaultI2vReferenceMode(body.i2vReferenceMode)],
      ['a music-video scene tag', body.musicVideo],
    ].filter(([, present]) => present).map(([label]) => label);
    if (unsupported.length) {
      throw new ServerError(
        `A federated media provider cannot render this clip — it uses ${unsupported.join(' and ')}. Render locally instead.`,
        { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
      );
    }

    const inputAssets = collectRemoteInputAssets('video', body);
    const impliedMode = body.lastImageFile ? 'fflf' : body.sourceImageFile ? 'image' : 'text';
    if (body.mode !== undefined && body.mode !== impliedMode) {
      throw new ServerError(
        `A federated render mode must match its conditioning — this request asks for '${body.mode}' but supplies ${impliedMode === 'text' ? 'no frames' : `a ${impliedMode} frame set`}. Render locally instead.`,
        { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
      );
    }
    if (!body.modelId) {
      throw new ServerError(
        'A federated render must name the provider model explicitly (modelId)',
        { status: 400, code: 'MEDIA_PROVIDER_MODEL_REQUIRED' },
      );
    }

    const request = buildFederatedMediaRequest({ kind: 'video', params: body });
    const { peer, remoteMedia } = await prepareRemoteMediaJob({
      peerId: body.mediaProviderPeerId,
      kind: 'video',
      request,
      inputAssets,
    });
    const { jobId, position, status } = enqueueJob({
      kind: 'video',
      params: { remoteMedia },
    });
    return {
      jobId,
      generationId: jobId,
      filename: `${jobId}.mp4`,
      model: request.modelId,
      mode: null,
      mediaProviderPeerId: peer.id,
      status,
      position,
    };
  }

  const prepared = await prepareVideoGenParams({
    body,
    uploads,
    localOnlyParamKeys: LOCAL_ONLY_VIDEO_PARAM_KEYS,
  });
  const { backend, cleanupStaged } = prepared;

  if (body.fableLoom) {
    const conditioningModel = backend === IMAGE_GEN_MODE.GROK
      ? { id: 'grok-video', supportedModes: ['image'] }
      : prepared.effectiveModel;
    const compiled = await compileFableLoomVisualRequest({
      tag: body.fableLoom,
      kind: 'video',
      capability: fableLoomVideoCapabilities({ backend, model: conditioningModel }),
      authoredPrompt: body.prompt,
      authoredNegativePrompt: body.negativePrompt,
      sourceImagePath: prepared.sourceImagePath,
    }).catch(async (error) => {
      await cleanupStaged();
      throw error;
    });
    if (compiled) {
      body.prompt = compiled.prompt;
      body.negativePrompt = compiled.negativePrompt;
      if (prepared.sourceImagePath && !compiled.sourceImagePath) {
        await prepared.discardSourceImage();
        prepared.uploadedTempPath = null;
        prepared.mode = 'text';
      }
      prepared.sourceImagePath = compiled.sourceImagePath;
      const renderSettings = fableLoomRenderSettings || asFableLoomRenderSettings();
      body.visualConditioning = compiled.visualConditioning ? {
        ...compiled.visualConditioning,
        render: {
          provider: backend,
          modelId: conditioningModel?.id || null,
          modelRevision: conditioningModel?.revision || null,
          parameters: {
            width: body.width,
            height: body.height,
            aspectRatio: renderSettings.aspectRatio,
          },
        },
      } : null;
    }
  }

  const enqueue = (params) => withStagedRollback(
    cleanupStaged,
    () => enqueueJob({ kind: 'video', params }),
  );

  if (backend === IMAGE_GEN_MODE.GROK) {
    const { grok: g, sourceImagePath, uploadedTempPath } = prepared;
    const { jobId, position, status } = await enqueue({
      mode: IMAGE_GEN_MODE.GROK,
      videoMode: sourceImagePath ? 'image' : 'text',
      grokPath: g.grokPath,
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio || g.aspectRatio,
      prompt: body.prompt,
      negativePrompt: body.negativePrompt || '',
      width: body.width,
      height: body.height,
      duration: body.grokDuration,
      sourceImagePath,
      uploadedTempPath,
      ...(body.musicVideo ? { musicVideo: body.musicVideo } : {}),
      ...(body.fableLoom ? { fableLoom: body.fableLoom } : {}),
      ...(body.visualConditioning ? { visualConditioning: body.visualConditioning } : {}),
    });
    return {
      jobId,
      generationId: jobId,
      filename: `${jobId}.mp4`,
      model: 'grok',
      mode: 'grok',
      status,
      position,
    };
  }

  const {
    pythonPath, effectiveModelId, effectiveNumFrames, mode,
    sourceImagePath, lastImagePath, audioFilePath, icReferencePaths,
    resolvedKeyframes, extendFromVideoPath,
    uploadedTempPath, uploadedTempPaths, loras, effectiveChunks,
    effectiveChunkPrompts, effectiveContextFrames,
  } = prepared;
  const { jobId, position, status } = await enqueue({
    pythonPath,
    prompt: body.prompt,
    negativePrompt: body.negativePrompt || '',
    modelId: body.modelId,
    width: body.width,
    height: body.height,
    ...(body.visualConditioning?.render?.parameters?.aspectRatio
      ? { aspectRatio: body.visualConditioning.render.parameters.aspectRatio }
      : {}),
    numFrames: effectiveNumFrames,
    fps: body.fps,
    steps: body.steps,
    guidanceScale: body.guidanceScale,
    seed: body.seed,
    tiling: body.tiling || 'auto',
    ...(isStockTextEncoder(body.textEncoderId) ? {} : { textEncoderId: body.textEncoderId }),
    ...(isDefaultSpeedProfile(body.speedProfileId) ? {} : { speedProfileId: body.speedProfileId }),
    ...(isFullDecode(body.draftDecode) ? {} : { draftDecode: body.draftDecode }),
    disableAudio: body.disableAudio === true || body.disableAudio === 'true',
    sourceImagePath,
    audioFilePath,
    audioStartSec: body.audioStartSec,
    uploadedTempPath,
    uploadedTempPaths,
    lastImagePath,
    keyframes: resolvedKeyframes,
    extendFromVideoPath,
    mode,
    imageStrength: body.imageStrength,
    ...(isDefaultI2vReferenceMode(body.i2vReferenceMode) ? {} : { i2vReferenceMode: body.i2vReferenceMode }),
    chunks: effectiveChunks,
    ...(effectiveChunkPrompts ? { chunkPrompts: effectiveChunkPrompts } : {}),
    ...(effectiveContextFrames != null ? { contextFrames: effectiveContextFrames } : {}),
    loras,
    icReferencePaths,
    icStrength: body.icStrength,
    icAttentionStrength: body.icAttentionStrength,
    icSkipStage2: body.icSkipStage2 === true || body.icSkipStage2 === 'true',
    ...(body.musicVideo ? { musicVideo: body.musicVideo } : {}),
    ...(body.fableLoom ? { fableLoom: body.fableLoom } : {}),
    ...(body.visualConditioning ? { visualConditioning: body.visualConditioning } : {}),
  });
  return {
    jobId,
    generationId: jobId,
    filename: `${jobId}.mp4`,
    model: effectiveModelId,
    mode: 'local',
    status,
    position,
  };
};

/**
 * @param {object} body - validated and coerced request body
 * @param {object} uploads - multipart uploads keyed by field name
 */
export async function submitVideoGenJob(body, uploads) {
  try {
    return await submitValidatedVideoGenJob(body, uploads);
  } catch (err) {
    await cleanupMultipartTemp(uploads);
    throw err;
  }
}

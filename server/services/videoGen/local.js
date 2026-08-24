/**
 * Video Gen — stable local-provider facade.
 *
 * Keep deep imports through this module working while the implementation lives
 * in focused render, orchestration, post-processing, and history modules.
 */

export * from './generateVideo.js';
export * from './chainedVideo.js';
export * from './frameExtraction.js';
export * from './historyOps.js';
export * from './stitchVideos.js';
export * from './upscaleVideo.js';

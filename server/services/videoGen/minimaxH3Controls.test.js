import { describe, it, expect } from 'vitest';
import { minimaxH3ControlError } from './minimaxH3Controls.js';

// The MLX and CUDA entries ship different frame grids on purpose (diffusers
// requires the snapped duration to land in 5-15 s, the MLX port accepts
// 4-15 s), which is exactly what the gate must read off the entry rather than
// hardcode.
const MLX = { runtime: 'minimax_h3', frameOptions: [107, 124, 141, 345, 362] };
const CUDA = { runtime: 'minimax_h3_cuda', frameOptions: [124, 141, 345] };

const legal = (model, overrides = {}) => minimaxH3ControlError({
  model, numFrames: 124, fps: 24, ...overrides,
});

describe('minimaxH3ControlError', () => {
  it('passes a legal request on either runtime', () => {
    expect(legal(MLX)).toBe(null);
    expect(legal(CUDA)).toBe(null);
  });

  it('rejects a negative prompt (the checkpoint is CFG-distilled)', () => {
    const err = legal(CUDA, { negativePrompt: 'blurry' });
    expect(err?.code).toBe('MINIMAX_H3_NEGATIVE_PROMPT_UNSUPPORTED');
    expect(err?.status).toBe(400);
  });

  it('treats a whitespace-only negative prompt as absent', () => {
    expect(legal(CUDA, { negativePrompt: '   ' })).toBe(null);
    expect(legal(CUDA, { negativePrompt: '' })).toBe(null);
  });

  it('rejects disabling audio, including the form-encoded string form', () => {
    expect(legal(CUDA, { disableAudio: true })?.code).toBe('MINIMAX_H3_AUDIO_REQUIRED');
    // A query-string / multipart caller sends strings, where Boolean('false')
    // is true — so an explicit opt-OUT must not read as an opt-in.
    expect(legal(CUDA, { disableAudio: 'true' })?.code).toBe('MINIMAX_H3_AUDIO_REQUIRED');
    expect(legal(CUDA, { disableAudio: 'false' })).toBe(null);
    expect(legal(CUDA, { disableAudio: false })).toBe(null);
    expect(legal(CUDA, { disableAudio: undefined })).toBe(null);
  });

  it('allows the default tiling value but rejects any other mode', () => {
    expect(legal(CUDA, { tiling: 'auto' })).toBe(null);
    expect(legal(CUDA, { tiling: undefined })).toBe(null);
    expect(legal(CUDA, { tiling: 'spatial' })?.code).toBe('MINIMAX_H3_TILING_UNSUPPORTED');
  });

  it('rejects a fps other than 24', () => {
    expect(legal(CUDA, { fps: 30 })?.code).toBe('MINIMAX_H3_INVALID_FPS');
    // String-typed fps from a form-encoded caller still compares numerically.
    expect(legal(CUDA, { fps: '24' })).toBe(null);
  });

  it('reads the frame grid off the entry, so each runtime quotes its own window', () => {
    // 107 is legal on the MLX grid and NOT on the diffusers one — the whole
    // reason this can't be a shared constant.
    expect(legal(MLX, { numFrames: 107 })).toBe(null);
    const err = legal(CUDA, { numFrames: 107 });
    expect(err?.code).toBe('MINIMAX_H3_INVALID_FRAME_COUNT');
    expect(err?.message).toContain('between 124 and 345');
    expect(legal(MLX, { numFrames: 362 })).toBe(null);
    expect(legal(CUDA, { numFrames: 362 })?.message).toContain('between 124 and 345');
  });

  it('accepts a string frame count (form-encoded caller)', () => {
    expect(legal(CUDA, { numFrames: '124' })).toBe(null);
  });

  it('rejects rather than waves through when the entry declares no frame grid', () => {
    const err = legal({ runtime: 'minimax_h3_cuda' }, { numFrames: 124 });
    expect(err?.code).toBe('MINIMAX_H3_INVALID_FRAME_COUNT');
    // Nothing to quote, so the message must not claim a bogus range.
    expect(err?.message).not.toMatch(/between/);
  });

  it('reports the negative prompt before the frame grid — the first illegal control wins', () => {
    const err = legal(CUDA, { negativePrompt: 'blurry', numFrames: 999 });
    expect(err?.code).toBe('MINIMAX_H3_NEGATIVE_PROMPT_UNSUPPORTED');
  });
});

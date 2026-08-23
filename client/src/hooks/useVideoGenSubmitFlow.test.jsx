import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useVideoGenSubmitFlow } from './useVideoGenSubmitFlow.js';

const submissionState = (prompt) => ({
  chainingActive: false,
  chunkPrompts: [],
  currentModel: { runtime: 'mlx_video' },
  disableAudio: false,
  icModeActive: false,
  icReferenceImageFiles: [],
  isGrok: false,
  keyframes: [],
  keyframesActive: false,
  mode: 'text',
  noMusic: false,
  prompt,
  selectedLoras: [],
});

describe('useVideoGenSubmitFlow', () => {
  it('keeps a stable submit callback that reads the latest form snapshot', () => {
    const { result, rerender } = renderHook(
      ({ prompt }) => useVideoGenSubmitFlow(submissionState(prompt)),
      { initialProps: { prompt: 'first prompt' } },
    );
    const build = result.current.buildGeneratePayload;
    expect(build().prompt).toBe('first prompt');

    rerender({ prompt: 'updated prompt' });
    expect(result.current.buildGeneratePayload).toBe(build);
    expect(build().prompt).toBe('updated prompt');
  });
});

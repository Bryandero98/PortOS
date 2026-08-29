import { describe, expect, it } from 'vitest';
import { buildFableLoomImageRequest, buildFableLoomVideoRequest } from './sceneMediaRequests';

const loom = { id: 'loom-1', styleNotes: 'cool rim light' };

describe('FableLoom scene media request composition', () => {
  it('prefixes the canonical universe style and carries its avoid list into image generation', () => {
    expect(buildFableLoomImageRequest({
      loom,
      episodeId: 'ep-1',
      node: { id: 'node-1', imagePrompt: 'a scout wakes in alien grass' },
      stylePreset: { prompt: 'painted graphic novel', negativePrompt: 'photorealism' },
    })).toEqual({
      prompt: 'painted graphic novel. a scout wakes in alien grass\n\nStyle: cool rim light',
      negativePrompt: 'photorealism',
      fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
    });
  });

  it('builds image-to-video direction from the shared camera vocabulary', () => {
    expect(buildFableLoomVideoRequest({
      loom,
      episodeId: 'ep-1',
      node: {
        id: 'node-1',
        prose: 'The gate opens.',
        videoPrompt: 'One continuous reveal.',
        cameraMovement: 'slow-dolly-in',
        image: 'scene.png',
      },
      stylePreset: { prompt: 'painted graphic novel', negativePrompt: 'photorealism' },
    })).toEqual({
      prompt: 'painted graphic novel. One continuous reveal.\n\nCamera direction: Camera slowly moves forward toward the subject.\n\nStyle: cool rim light',
      negativePrompt: 'photorealism',
      backend: 'local',
      mode: 'image',
      sourceImageFile: 'scene.png',
      disableAudio: true,
      fableLoom: JSON.stringify({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' }),
    });
  });
});

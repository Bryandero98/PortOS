import { describe, expect, it } from 'vitest';
import { sanitizeJob } from './sanitizeJob.js';

describe('sanitizeJob', () => {
  it('exposes safe video retry configuration fields', () => {
    const sanitized = sanitizeJob({
      id: 'video-job',
      kind: 'video',
      status: 'failed',
      params: {
        modelId: 'example-video-model',
        textEncoderId: 'example-encoder',
        chunks: 2,
        chunkPrompts: ['opening', 'climax'],
        contextFrames: 12,
        loras: [{ filename: 'example-style.safetensors', scale: 0.8 }],
        pythonPath: '/private/internal/python',
      },
    });

    expect(sanitized.params).toEqual({
      modelId: 'example-video-model',
      textEncoderId: 'example-encoder',
      chunks: 2,
      chunkPrompts: ['opening', 'climax'],
      contextFrames: 12,
      loras: [{ filename: 'example-style.safetensors', scale: 0.8 }],
    });
  });

  it('exposes instrumental mode without leaking authored Music Studio text', () => {
    const job = sanitizeJob({
      id: 'job-1',
      kind: 'audio',
      status: 'running',
      params: {
        prompt: 'safe conditioning prompt',
        lyrics: 'private lyric draft',
        musicStudio: {
          trackId: 'track-1',
          authoredPrompt: 'private source prompt',
          authoredLyrics: 'private lyric draft',
          instrumentalOnly: true,
        },
      },
    });

    expect(job.params.musicStudio).toEqual({ trackId: 'track-1', instrumentalOnly: true });
    expect(job.params).not.toHaveProperty('lyrics');
  });

  it('restores the public prompt without exposing private peer routing fields', () => {
    const sanitized = sanitizeJob({
      id: 'job-example',
      kind: 'audio',
      status: 'queued',
      params: {
        prompt: '',
        modelId: 'example/model',
        remoteMedia: {
          wireVersion: 1,
          peerId: '00000000-0000-4000-8000-000000000001',
          profile: {
            style: 'orchestral',
            mood: 'triumphant',
            tempo: 'moderate',
            energy: 'high',
            instruments: ['brass', 'strings'],
          },
          request: {
            engine: 'remote-audio',
            modelId: 'example/model',
          },
        },
      },
    });

    expect(sanitized.params).toEqual({
      prompt: 'Instrumental orchestral music with a triumphant mood, moderate tempo, high energy, featuring brass and strings. No vocals or spoken words.',
      modelId: 'example/model',
      renderer: 'remote',
    });
    expect(sanitized.params).not.toHaveProperty('remoteMedia');
  });

  it('restores an image/video remote job prompt and model from its marker, not from params', () => {
    const sanitized = sanitizeJob({
      id: 'job-image',
      kind: 'image',
      status: 'running',
      params: {
        // Blank/nulled on purpose: the prompt and the model live only inside
        // the versioned marker so an older build that cannot route it fails
        // closed instead of rendering (#4683).
        prompt: '',
        modelId: null,
        width: 512,
        height: 512,
        remoteMedia: {
          wireVersion: 1,
          peerId: '00000000-0000-4000-8000-000000000001',
          request: {
            kind: 'image',
            engine: 'local',
            modelId: 'dev',
            prompt: 'a lighthouse at dusk',
            width: 512,
            height: 512,
          },
        },
      },
    });

    expect(sanitized.params).toEqual({
      prompt: 'a lighthouse at dusk',
      modelId: 'dev',
      width: 512,
      height: 512,
      // Display-only: the Render Queue badges this 'remote / dev' rather than
      // claiming a local render produced it.
      renderer: 'remote',
    });
    expect(sanitized.params).not.toHaveProperty('remoteMedia');
  });

  it('leaves a local job unbadged so it keeps the local render label', () => {
    const sanitized = sanitizeJob({
      id: 'job-local',
      kind: 'image',
      status: 'running',
      params: { prompt: 'a lighthouse at dusk', modelId: 'dev' },
    });

    expect(sanitized.params).toEqual({ prompt: 'a lighthouse at dusk', modelId: 'dev' });
    expect(sanitized.params).not.toHaveProperty('renderer');
  });
});

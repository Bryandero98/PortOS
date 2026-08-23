import { describe, expect, it } from 'vitest';
import {
  FEDERATED_MEDIA_FEATURES,
  federatedMediaAudioProfileSchema,
  federatedMediaCapabilitySchema,
  federatedMediaProviderStatusSchema,
  federatedMediaProviderJobSchema,
  effectiveJobPrompt,
  isFederatedMediaAudioPrompt,
  federatedMediaSupports,
  normalizeRequestedMediaKinds,
  renderFederatedMediaAudioPrompt,
} from './federatedMediaWire.js';

const job = (overrides = {}) => ({
  wireVersion: 1,
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'audio',
  status: 'queued',
  queuedAt: '2026-08-17T12:00:00.000Z',
  startedAt: null,
  completedAt: null,
  position: 1,
  progress: null,
  etaMs: null,
  ...overrides,
});

describe('federated media provider job wire projection', () => {
  it('strips unknown provider fields before consumer reconciliation', () => {
    const parsed = federatedMediaProviderJobSchema.parse(job({ privateFutureField: 'do-not-relay' }));
    expect(parsed.privateFutureField).toBeUndefined();
  });

  it('rejects invalid integrity metadata and kinds outside the known wire-v1 alphabet', () => {
    expect(federatedMediaProviderJobSchema.safeParse(job({
      status: 'completed',
      completedAt: '2026-08-17T12:01:00.000Z',
      result: {
        available: true,
        mimeType: 'audio/wav',
        sizeBytes: 10,
        sha256: 'not-a-hash',
        downloadUrl: '/result',
        engine: 'example-engine',
        modelId: 'example/model',
        durationSec: 30,
      },
    })).success).toBe(false);
    expect(federatedMediaProviderJobSchema.safeParse(job({ kind: 'holo' })).success).toBe(false);
  });

  it('accepts image and video as first-class kinds, each with their own result mime type', () => {
    expect(federatedMediaProviderJobSchema.safeParse(job({ kind: 'video' })).success).toBe(true);
    expect(federatedMediaProviderJobSchema.safeParse(job({
      kind: 'image',
      status: 'completed',
      completedAt: '2026-08-17T12:01:00.000Z',
      result: {
        available: true,
        mimeType: 'image/png',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        downloadUrl: '/result',
        engine: 'local',
        modelId: 'flux-dev',
        durationSec: null,
      },
    })).success).toBe(true);
    expect(federatedMediaProviderJobSchema.safeParse(job({
      kind: 'image',
      status: 'completed',
      completedAt: '2026-08-17T12:01:00.000Z',
      result: {
        available: true,
        mimeType: 'video/mp4',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        downloadUrl: '/result',
        engine: 'local',
        modelId: 'example/model',
        durationSec: null,
      },
    })).success).toBe(false);
  });
});

describe('federated media status kind projection', () => {
  const status = (overrides = {}) => ({
    wireVersion: 1,
    generatedAt: '2026-08-17T12:00:00.000Z',
    staleAfterMs: 60_000,
    status: 'ready',
    kinds: ['audio'],
    queue: {
      totalActive: 0,
      providerActive: 0,
      queued: 0,
      running: 0,
      maxQueuedJobs: 2,
      accepting: true,
    },
    capabilities: [],
    ...overrides,
  });

  it('rejects a capability kind omitted from the negotiated projection', () => {
    expect(federatedMediaProviderStatusSchema.safeParse(status({
      capabilities: [{
        kind: 'image', engine: 'local', engineName: 'Local', modelId: 'example/model', modelName: 'Example',
        ready: true, unavailableReason: null, runtimeReady: true, platformSupported: true,
        cudaRequired: false, cudaState: 'available', minDurationSec: null, maxDurationSec: null,
        defaultDurationSec: null, lyrics: false, autoDuration: false,
      }],
    })).success).toBe(false);
  });

  it('validates capabilities with frameStride, maxNumFrames, frameOptions, and resolutionOptions', () => {
    const capability = {
      kind: 'video',
      engine: 'local',
      engineName: 'Local',
      modelId: 'wan22_t2v_a14b',
      modelName: 'Wan 2.2 T2V A14B',
      ready: true,
      unavailableReason: null,
      runtimeReady: true,
      platformSupported: true,
      cudaRequired: false,
      cudaState: 'available',
      minDurationSec: null,
      maxDurationSec: null,
      defaultDurationSec: null,
      lyrics: false,
      autoDuration: false,
      frameStride: 4,
      maxNumFrames: 121,
      frameOptions: [25, 49, 73, 97, 121],
      fpsOptions: [16, 20, 24],
      resolutionOptions: [{ w: 1344, h: 768, label: '16:9 H3 default' }],
    };

    expect(federatedMediaCapabilitySchema.safeParse(capability).success).toBe(true);
    expect(federatedMediaProviderStatusSchema.safeParse(status({
      kinds: ['video'],
      capabilities: [capability],
    })).success).toBe(true);
  });

  it('validates an older provider payload omitting the frame and canvas constraint fields', () => {
    const legacyCapability = {
      kind: 'video',
      engine: 'local',
      engineName: 'Local',
      modelId: 'ltx23_distilled_q4',
      modelName: 'LTX-2.3 Distilled Q4',
      ready: true,
      unavailableReason: null,
      runtimeReady: true,
      platformSupported: true,
      cudaRequired: false,
      cudaState: 'available',
      minDurationSec: null,
      maxDurationSec: null,
      defaultDurationSec: null,
      lyrics: false,
      autoDuration: false,
    };

    expect(federatedMediaCapabilitySchema.safeParse(legacyCapability).success).toBe(true);
    const parsed = federatedMediaCapabilitySchema.parse(legacyCapability);
    expect(parsed.frameStride).toBeUndefined();
    expect(parsed.maxNumFrames).toBeUndefined();
    expect(parsed.resolutionOptions).toBeUndefined();
  });

  it('validates a queue block reporting concurrency and per-kind occupancy', () => {
    const parsed = federatedMediaProviderStatusSchema.parse(status({
      kinds: ['audio', 'image', 'video'],
      queue: {
        totalActive: 3,
        providerActive: 1,
        queued: 0,
        running: 1,
        maxQueuedJobs: 4,
        accepting: true,
        concurrency: 2,
        byKind: {
          audio: { running: 1, queued: 0 },
          image: { running: 0, queued: 1 },
        },
      },
    }));
    expect(parsed.queue.concurrency).toBe(2);
    expect(parsed.queue.byKind.image).toEqual({ running: 0, queued: 1 });
  });

  it('validates an older provider queue block omitting concurrency and byKind', () => {
    const parsed = federatedMediaProviderStatusSchema.parse(status());
    expect(parsed.queue.concurrency).toBeUndefined();
    expect(parsed.queue.byKind).toBeUndefined();
  });

  // The provider reports only the kinds holding a lane, and the kind list is
  // negotiated besides. A record that demanded every key would make an
  // audio-only projection unparseable the moment a fourth kind is added.
  it('accepts a byKind covering only some kinds', () => {
    expect(federatedMediaProviderStatusSchema.safeParse(status({
      queue: { ...status().queue, byKind: { audio: { running: 1, queued: 0 } } },
    })).success).toBe(true);
  });

  it('rejects a byKind entry that is not a non-negative count pair', () => {
    const bad = (byKind) => federatedMediaProviderStatusSchema.safeParse(status({
      queue: { ...status().queue, byKind },
    })).success;
    expect(bad({ audio: { running: -1, queued: 0 } })).toBe(false);
    expect(bad({ audio: { running: 1 } })).toBe(false);
    expect(bad({ holo: { running: 1, queued: 0 } })).toBe(false);
  });

  it('validates a features list and drops the field entirely when a provider omits it', () => {
    expect(federatedMediaProviderStatusSchema.parse(status({ features: ['lyrics'] })).features)
      .toEqual(['lyrics']);
    expect(federatedMediaProviderStatusSchema.parse(status()).features).toBeUndefined();
  });

  // The byKind lesson applied to features: a Zod enum would reject the ENTIRE
  // payload on an unrecognized member, so the day a provider ships a fourth
  // feature every older consumer would stop reading its status at all instead
  // of ignoring one string.
  it('accepts a feature this build does not recognize rather than failing the payload', () => {
    const parsed = federatedMediaProviderStatusSchema
      .safeParse(status({ features: ['lyrics', 'holoProjection'] }));
    expect(parsed.success).toBe(true);
    expect(federatedMediaSupports(parsed.data, 'holoProjection')).toBe(true);
  });

  it('rejects a features entry shaped like free-form text', () => {
    const bad = (features) => federatedMediaProviderStatusSchema
      .safeParse(status({ features })).success;
    expect(bad(['a private note about the user'])).toBe(false);
    expect(bad([''])).toBe(false);
    expect(bad(['x'.repeat(41)])).toBe(false);
  });

    it('rejects a concurrency that claims no capacity at all', () => {
    expect(federatedMediaProviderStatusSchema.safeParse(status({
      queue: { ...status().queue, concurrency: 0 },
    })).success).toBe(false);
  });
});

describe('normalizeRequestedMediaKinds', () => {
  it('defaults to audio-only so an unopted-in caller gets the original shape', () => {
    expect(normalizeRequestedMediaKinds()).toEqual(['audio']);
    expect(normalizeRequestedMediaKinds('')).toEqual(['audio']);
    expect(normalizeRequestedMediaKinds('nonsense,also-bad')).toEqual(['audio']);
  });

  it('parses a comma-separated list down to the known, deduplicated subset', () => {
    expect(normalizeRequestedMediaKinds('audio,image,image,video,holo')).toEqual(['audio', 'image', 'video']);
    expect(normalizeRequestedMediaKinds(['video', ' image '])).toEqual(['video', 'image']);
  });
});

describe('federated media privacy-safe audio profiles', () => {
  it('renders provider prompts only from fixed musical vocabulary', () => {
    const profile = {
      style: 'cinematic',
      mood: 'dreamy',
      tempo: 'slow',
      energy: 'medium',
      instruments: ['strings', 'synthesizer'],
    };

    const prompt = renderFederatedMediaAudioPrompt(profile);
    expect(prompt).toBe('Instrumental cinematic music with a dreamy mood, slow tempo, medium energy, featuring strings and synthesizer. No vocals or spoken words.');
    expect(isFederatedMediaAudioPrompt(prompt)).toBe(true);
    expect(isFederatedMediaAudioPrompt('Cinematic music for alice@example.com')).toBe(false);
    expect(federatedMediaAudioProfileSchema.safeParse({
      ...profile,
      subject: 'alice@example.com',
    }).success).toBe(false);
    expect(renderFederatedMediaAudioPrompt({ ...profile, mood: 'a named person' })).toBeNull();
  });
});

describe('effectiveJobPrompt', () => {
  it('reads a routed job through to the wire request, not the blanked params', () => {
    // A routed job's top-level prompt is blank on purpose (#4683). Anything
    // recording what was rendered must read the marker, or it files a finished
    // render with no prompt at all.
    expect(effectiveJobPrompt({
      kind: 'image',
      params: {
        prompt: '',
        remoteMedia: { wireVersion: 1, request: { kind: 'image', modelId: 'dev', prompt: 'a lighthouse at dusk' } },
      },
    })).toBe('a lighthouse at dusk');
  });

  it('renders an audio job from its fixed-vocabulary profile', () => {
    expect(effectiveJobPrompt({
      kind: 'audio',
      params: {
        prompt: '',
        remoteMedia: {
          wireVersion: 1,
          profile: { style: 'ambient', mood: 'calm', tempo: 'slow', energy: 'low', instruments: [] },
          request: { engine: 'remote-audio', modelId: 'example/model' },
        },
      },
    })).toBe('Instrumental ambient music with a calm mood, slow tempo, low energy. No vocals or spoken words.');
  });

  it('returns a local job\'s own prompt untouched', () => {
    expect(effectiveJobPrompt({ kind: 'image', params: { prompt: 'a fox' } })).toBe('a fox');
  });

  it('distinguishes no prompt at all from a legitimately empty one', () => {
    expect(effectiveJobPrompt({ kind: 'image', params: {} })).toBeNull();
    expect(effectiveJobPrompt(undefined)).toBeNull();
    // An img2img render genuinely has no text — that is an empty string, not
    // "nothing was recorded".
    expect(effectiveJobPrompt({ kind: 'image', params: { prompt: '' } })).toBe('');
  });
});

describe('federatedMediaSupports', () => {
  const capability = (overrides = {}) => ({ kind: 'audio', lyrics: true, ...overrides });

  it('reads an absent features list as the wire-v1 baseline', () => {
    expect(federatedMediaSupports(null, 'lyrics')).toBe(false);
    expect(federatedMediaSupports({}, 'lyrics', capability())).toBe(false);
    expect(federatedMediaSupports({ features: [] }, 'inputAssets')).toBe(false);
    // A model that sings is not, on its own, a build that carries the words.
    expect(federatedMediaSupports({ features: [] }, 'lyrics', capability({ lyrics: true }))).toBe(false);
  });

  it('reads the status-root list without needing a capability', () => {
    expect(federatedMediaSupports({ features: ['lyrics'] }, 'lyrics')).toBe(true);
    expect(federatedMediaSupports({ features: ['lyrics'] }, 'inputAssets')).toBe(false);
  });

  // The overlap release: a peer on the previous build sends the per-capability
  // field and no root list, and must keep working unchanged.
  it('falls back to the legacy per-capability field', () => {
    expect(federatedMediaSupports({}, 'lyrics', capability({ acceptsLyrics: true }))).toBe(true);
    expect(federatedMediaSupports({}, 'lyrics', capability({ acceptsLyrics: false }))).toBe(false);
    expect(federatedMediaSupports({}, 'inputAssets', capability({ inputAssets: { roles: ['initImage'] } }))).toBe(true);
    expect(federatedMediaSupports({}, 'inputAssets', capability({ inputAssets: null }))).toBe(false);
  });

  it('exposes every feature this build emits, and answers false for anything else', () => {
    expect([...FEDERATED_MEDIA_FEATURES]).toEqual(['lyrics', 'inputAssets']);
    for (const feature of FEDERATED_MEDIA_FEATURES) {
      expect(federatedMediaSupports({ features: [...FEDERATED_MEDIA_FEATURES] }, feature)).toBe(true);
    }
    expect(federatedMediaSupports({ features: ['lyrics'] }, 'constructor', capability())).toBe(false);
  });
});

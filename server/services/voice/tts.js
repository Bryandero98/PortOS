// TTS façade — dispatches on cfg.tts.engine ('kokoro' default | 'piper').

import { getVoiceConfig, piperVoiceTildePath } from './config.js';
import { synthesizeKokoro, listKokoroVoices } from './tts-kokoro.js';
import { synthesizePiper, listPiperVoices } from './tts-piper.js';
import { findPiperVoice } from './piper-voices.js';
import { isKokoroVoice } from './kokoro-voices.js';
import { getProfileForSynthesis } from './profiles.js';
import { which } from './bootstrap.js';
import { ServerError } from '../../lib/errorHandler.js';

// Single source of truth for the supported TTS engine names. Imported by
// routes/voice.js, routes/pipeline/audio.js, and services/pipeline/audio.js so a
// new engine (e.g. ElevenLabs) shows up in every consumer with one edit.
export const VALID_ENGINES = new Set(['kokoro', 'piper']);

// Capability discovery is deliberately honest about the first two backends:
// they can wrap stable presets and honour a rate, but do not offer voice
// design/cloning, pitch/formant transforms, or streaming controls. A future
// engine can expand this contract without making the Voice Lab expose a knob
// that the selected backend silently ignores.
let voiceTransformProbe = null;

const probeVoiceTransforms = () => {
  if (!voiceTransformProbe) {
    voiceTransformProbe = which('rubberband').then((rubberband) => ({
      rubberband: Boolean(rubberband),
    }));
  }
  return voiceTransformProbe;
};

export const listVoiceEngines = async () => {
  const transforms = await probeVoiceTransforms();
  const unavailableControls = transforms.rubberband
    ? 'Rubber Band is installed, but PortOS has no approved formant-preserving adapter yet. Pitch and formant controls remain disabled until that adapter is enabled.'
    : 'Install Rubber Band to enable a future formant-preserving transform. Pitch and formant controls remain disabled rather than approximated by sample-rate changes.';
  return [
    {
    id: 'kokoro',
    capabilities: {
      preset: true, voiceDesign: false, instantClone: false, fineTune: false,
      streaming: false, instructionControl: false, emotionControl: false,
      seed: false, wordTimings: false, rate: true, pitch: false, formant: false,
    },
      unavailableControls,
      transformProbe: transforms,
    },
    {
    id: 'piper',
    capabilities: {
      preset: true, voiceDesign: false, instantClone: false, fineTune: false,
      streaming: false, instructionControl: false, emotionControl: false,
      seed: false, wordTimings: false, rate: true, pitch: false, formant: false,
    },
      unavailableControls,
      transformProbe: transforms,
    },
  ];
};

// Normalize `engine` against the allowlist so an invalid value can't silently
// produce Kokoro audio while the response reports `engine: 'elevenlabs'`.
const resolveEngine = (engine) => VALID_ENGINES.has(engine) ? engine : 'kokoro';

const backend = (engine) => {
  if (engine === 'piper') return { synth: synthesizePiper, list: listPiperVoices };
  return { synth: synthesizeKokoro, list: listKokoroVoices };
};

/**
 * Synthesize text with the active TTS engine. `opts.voice` and `opts.engine`
 * override the configured voice/engine just for this call — used by the
 * voice-picker preview so users can audition before saving.
 * @param {string} text
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.voice]  transient voice override
 * @param {string} [opts.engine] transient engine override ('kokoro'|'piper')
 * @param {number} [opts.rate]   transient speech-rate override (0.25–4)
 * @returns {Promise<{ wav: Buffer, latencyMs: number, engine: string }>}
 */
export const synthesize = async (text, opts = {}) => {
  const cfg = await getVoiceConfig();
  const profile = opts.profileId
    ? await getProfileForSynthesis(opts.profileId, opts.route || 'studio')
    : null;
  const profileVoice = profile?.voiceId?.split(':')[1] || null;
  // An approved profile owns its engine/preset. Letting a caller override one
  // would render the wrong character while claiming profile provenance.
  const engine = profile ? profile.engine : resolveEngine(opts.engine || cfg.tts.engine);
  const { synth } = backend(engine);
  // A profile snapshots the delivery rate at its explicit promotion. It is
  // therefore immune to later project-default changes, while legacy preset
  // synthesis keeps the old config-driven behavior.
  let ttsCfg = profile ? { ...cfg.tts, rate: profile.delivery.rate } : cfg.tts;
  // Transient rate override (external public API lets a caller set speed per
  // request without persisting it). Clamp defensively even though the route
  // schema already bounds it — direct in-process callers bypass the route.
  if (typeof opts.rate === 'number' && Number.isFinite(opts.rate)) {
    ttsCfg = { ...ttsCfg, rate: Math.min(4, Math.max(0.25, opts.rate)) };
  }
  const voice = profileVoice || opts.voice;
  if (voice) {
    // Spread from `ttsCfg` (not `cfg.tts`) so a transient rate override applied
    // above is preserved alongside the voice override.
    if (engine === 'kokoro') {
      // Reject unknown Kokoro voice overrides (symmetric with the Piper branch
      // below) so the public synth API returns the documented 400 UNKNOWN_VOICE
      // instead of forwarding a bogus id to the model and erroring/wrong-voicing.
      if (!isKokoroVoice(voice)) {
        throw new ServerError(`unknown kokoro voice: ${voice}`, {
          status: 400,
          code: 'UNKNOWN_VOICE',
        });
      }
      ttsCfg = { ...ttsCfg, kokoro: { ...ttsCfg.kokoro, voice } };
    } else {
      // Reject Piper voice overrides that aren't in the curated catalog —
      // otherwise `voice` would change but `voicePath` would remain the
      // previous config value, silently synthesizing the wrong voice.
      const catalog = findPiperVoice(voice);
      if (!catalog) {
        throw new ServerError(`unknown piper voice: ${voice}`, {
          status: 400,
          code: 'UNKNOWN_VOICE',
        });
      }
      ttsCfg = {
        ...ttsCfg,
        piper: {
          ...ttsCfg.piper,
          voice,
          voicePath: piperVoiceTildePath(voice),
          speakerId: null,
        },
      };
    }
  }
  const result = await synth(text, ttsCfg, opts.signal);
  const modelRevision = engine === 'kokoro'
    ? `${ttsCfg.kokoro.modelId}:${ttsCfg.kokoro.dtype}`
    : `piper:${ttsCfg.piper.voice}`;
  return {
    ...result,
    engine,
    ...(profile ? {
      profileId: profile.id,
      profileRevision: profile.version,
      provenance: {
        profileId: profile.id,
        profileRevision: profile.version,
        engine,
        modelRevision,
        effectiveControls: { rate: ttsCfg.rate },
        mastering: profile.mastering,
      },
    } : {}),
  };
};

/**
 * Enumerate voices available for the given engine (or the configured one).
 * @param {string} [engineOverride] 'kokoro' | 'piper' to preview voices for
 *   an engine without saving it as active.
 * @returns {Promise<{ engine: string, voices: Array }>}
 */
export const listVoices = async (engineOverride) => {
  const cfg = await getVoiceConfig();
  const engine = resolveEngine(engineOverride || cfg.tts.engine);
  const { list } = backend(engine);
  return { engine, voices: await list() };
};

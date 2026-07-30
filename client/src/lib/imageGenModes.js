/**
 * Image/video render-backend constants + pure helpers — the NODE-SAFE half of
 * `imageGenBackends.js`, split out (#3231 Phase 4) because the server-side
 * parity suite (`server/lib/renderTargets.parity.test.js`) and the server CI
 * job import this module directly, where client-only packages (lucide-react)
 * are not installed. Nothing here may import React, icons, or any package —
 * keep this file dependency-free. Icon metadata and settings-driven backend
 * derivation stay in `imageGenBackends.js`, which re-exports everything below
 * so client consumers keep a single import site.
 */

export const IMAGE_GEN_MODE = Object.freeze({
  LOCAL: 'local',
  CODEX: 'codex',
  GROK: 'grok',
  AGY: 'agy',
  EXTERNAL: 'external',
});

// Shipped default Codex reasoning-effort level — the client mirror of the
// server's CODEX_IMAGEGEN_DEFAULT_EFFORT (server/services/imageGen/modes.js).
// A Codex job with no explicit effort renders at this level, so any UI that
// displays or pre-fills "the effort a job used" must resolve an absent value to
// this default rather than showing a blank.
export const CODEX_IMAGEGEN_DEFAULT_EFFORT = 'low';

// Client mirror of the server's AGY_IMAGEGEN_DEFAULT_MODEL
// (server/services/imageGen/modes.js, #3231) — the cheap-tier agent/session
// model an unpinned agy render runs on. Any UI naming "the model an agy job
// used" must resolve an absent value to this, not to "agy's own default"
// (which stopped being true when the pin shipped).
export const AGY_IMAGEGEN_DEFAULT_MODEL = 'gemini-3.5-flash-low';

// Client mirror of AGY_IMAGEGEN_IMAGE_MODEL — the image model behind agy's
// generate_image tool, fixed server-side by Antigravity and NOT selectable by
// PortOS (all three channels probed and closed — see the server constant's
// comment). Surfaced read-only in Settings so the agent-model field can't be
// mistaken for an image-model picker.
export const AGY_IMAGEGEN_IMAGE_MODEL = 'imagen-3.0-generate-002';

// Client mirror of the server's render-target alphabet
// (server/lib/renderTargets.js, #3231) — the surfaces whose default backend +
// model are pinnable via settings.renderDefaults. Only targets whose resolver
// is LIVE are listed here — showing a pin no resolver reads would be a control
// that silently does nothing. Labels are the Settings-UI display names.
// `video: true` marks the targets whose VIDEO lane also consults
// `renderDefaults[target].videoMode` (#3231 Phase 4): music-video (scene clips
// + new-project backend seeding) and creative-agent (commission video steps).
// Video pins are backend-only — grok video has no model knob
// (supportsModelOverride: false) and local video models are picked on the
// surface itself, so no video-model control is offered anywhere.
export const RENDER_TARGET_BACKEND_AUTO = 'auto';
export const RENDER_TARGET_OPTIONS = Object.freeze([
  { id: 'universe-bible', label: 'Universe Bible batch renders' },
  { id: 'universe-character-sheet', label: 'Universe character sheets' },
  { id: 'series-first-pass', label: 'Series first-pass portraits & frames' },
  { id: 'sprite-reference', label: 'Sprite references & anchors' },
  { id: 'pipeline-visual', label: 'Pipeline visuals (storyboards, comics, covers)' },
  { id: 'music-video', label: 'Music Video scene frames & clips', video: true },
  { id: 'lora-dataset', label: 'LoRA training datasets' },
  { id: 'creative-agent', label: 'Creative agent renders', video: true },
]);

// Client mirror of the server's VIDEO_GEN_MODES (services/videoGen/modes.js) —
// the backend alphabet for the video pin controls above and the install-wide
// `settings.videoGen.mode` pin.
export const VIDEO_RENDER_MODES = Object.freeze(['local', 'grok']);

// Client mirror of the server's normalizeRenderPinValue
// (server/lib/renderTargets.js) — THE one render-pin normalization rule: trim;
// the 'auto' sentinel and blank strings collapse to null ("no pin").
export const normalizeRenderPinValue = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== RENDER_TARGET_BACKEND_AUTO ? s : null;
};

// Client mirror of the server's GROK_ASPECT_RATIOS (imageGen/grok.js) — the
// aspect ratios grok's image_gen/image_edit tools accept, offered as the
// default-ratio picker in Settings → Image Gen → Grok.
export const GROK_ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

// Human-facing backend names — the pure half of imageGenBackends' per-mode
// metadata (its icon half stays there with the lucide import).
export const MODE_LABELS = Object.freeze({
  [IMAGE_GEN_MODE.LOCAL]: 'Local',
  [IMAGE_GEN_MODE.CODEX]: 'Codex',
  [IMAGE_GEN_MODE.GROK]: 'Grok',
  [IMAGE_GEN_MODE.AGY]: 'Agy',
  [IMAGE_GEN_MODE.EXTERNAL]: 'External',
});

// Client mirror of the server's CLOUD_IMAGE_GEN_MODES (imageGen/modes.js) —
// cloud-CLI backends that pick model/steps/seed internally,
// run through the media queue's parallel cloud lane, and need a prompt for
// text-to-image. Use `isCloudCliMode` instead of hand-rolled
// `mode === CODEX || mode === GROK` disjunctions.
export const CLOUD_IMAGE_GEN_MODES = Object.freeze([
  IMAGE_GEN_MODE.CODEX,
  IMAGE_GEN_MODE.GROK,
  IMAGE_GEN_MODE.AGY,
]);
export const isCloudCliMode = (mode) => CLOUD_IMAGE_GEN_MODES.includes(mode);

// Client mirror of the server's `supportsModelOverride` spec flag
// (imageGen/cloudProviderConfig.js) — cloud CLIs that accept a per-render
// `cloudModel` replacing the saved `settings.imageGen.<mode>.model` for one
// queue item. Grok is absent because its image tools run on a fixed xAI backend
// with no model knob, so offering the control there would be a lie.
// Use `supportsCloudModelOverride` instead of hand-rolled
// `mode === CODEX || mode === AGY` disjunctions — the two must stay in lock-step
// with the server spec, and a new CLI backend should be one entry here.
export const MODEL_OVERRIDE_CAPABLE_MODES = Object.freeze([
  IMAGE_GEN_MODE.CODEX,
  IMAGE_GEN_MODE.AGY,
]);
export const supportsCloudModelOverride = (mode) => MODEL_OVERRIDE_CAPABLE_MODES.includes(mode);

// Human-facing name for a backend ('Local', 'Codex', 'Grok', 'Agy', 'External').
// Shared so label ladders (`isCodex ? 'Codex model' : …`) don't re-type what
// MODE_LABELS already holds and grow a branch per backend.
export const modeLabel = (mode) => MODE_LABELS[mode] || mode || '';

// Backends that support image-to-image (init image / reference editing). The
// external SD-API path does not. Single source of truth for i2i gating in the UI.
export const I2I_CAPABLE_MODES = Object.freeze([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK]);

// True when a mode can run image-to-image.
export const isI2iCapableMode = (mode) => I2I_CAPABLE_MODES.includes(mode);

// Pick the best available i2i backend from a list of `{ id }` backends,
// preferring local (its form exposes strength + LoRAs), else codex, else grok.
// Returns null when none is installed.
export function pickI2iMode(backends) {
  for (const mode of I2I_CAPABLE_MODES) {
    if (backends.some((b) => b.id === mode)) return mode;
  }
  return null;
}

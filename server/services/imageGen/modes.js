/**
 * Image Gen — mode enum.
 *
 * Standalone so the dispatcher (`index.js`) and the provider modules
 * (`codex.js`, `local.js`, `external.js`) can both import without forming a
 * cycle (index.js already imports from each provider).
 *
 * `IMAGE_GEN_MODE.X` is the preferred form at branching/tagging sites.
 * `IMAGE_GEN_MODES` is the alphabet for Zod / OpenAI tool-spec enums.
 * Single source of truth: derive the array from `Object.values(...)`.
 */

export const IMAGE_GEN_MODE = Object.freeze({
  EXTERNAL: 'external',
  LOCAL: 'local',
  CODEX: 'codex',
  GROK: 'grok',
  AGY: 'agy',
});

export const IMAGE_GEN_MODES = Object.freeze(Object.values(IMAGE_GEN_MODE));

// Cloud-CLI backends (codex `$imagegen`, grok `image_gen`) — each render
// shells out to an external child that spends remote quota, not local GPU.
// The mediaJobQueue routes these through its parallel cloud lane (they don't
// serialize on the MLX runtime) and async callers treat them like local:
// generateImage returns a job descriptor before the file lands.
export const CLOUD_IMAGE_GEN_MODES = Object.freeze([
  IMAGE_GEN_MODE.CODEX,
  IMAGE_GEN_MODE.GROK,
  IMAGE_GEN_MODE.AGY,
]);

// Modes the mediaJobQueue can run (external SD-API stays synchronous — a
// remote HTTP call with no local single-flight constraint to absorb). Single
// source for the pipeline routes' Zod enums and batch-render guards, so a
// future backend is one edit here instead of a sweep of enum literals.
export const QUEUEABLE_IMAGE_MODES = Object.freeze([IMAGE_GEN_MODE.LOCAL, ...CLOUD_IMAGE_GEN_MODES]);

// Cloud-CLI providers expose no numeric i2i denoise knob, so map the
// local-runner-style strength (0..1, lower = more faithful to the source)
// onto a phrase the model reliably honors. Mirrors
// PROOF_AS_BASE_DEFAULT_STRENGTH (0.25) defaulting toward
// composition-preserving edits. Lives here (the shared no-dependency module)
// so codex.js and grok.js both import it without a provider→provider import.
export const describeFidelity = (strength) => {
  const n = Number.isFinite(strength) ? Math.max(0, Math.min(1, Number(strength))) : 0.25;
  if (n <= 0.2) return 'preserve composition, characters, and layout exactly — only refine detail and resolution';
  if (n <= 0.4) return 'preserve composition and characters while adding rendered detail at higher fidelity';
  if (n <= 0.7) return 'use the attached image as a strong reference while refining art and detail';
  return 'use the attached image as a loose reference; you may reinterpret freely';
};

// Shipped defaults for the Codex imagegen backend. Codex's built-in image_gen
// tool otherwise runs whatever model its logged-in session defaults to — often
// the heaviest, most expensive tier — at default reasoning effort. Pin the cheap
// `gpt-5.6-luna` model at `low` reasoning effort so every media-pipeline render
// pays the light path by default. Applied as a code-level default (not a
// settings migration) so it reaches every install and federated peer with no
// per-install bookkeeping; an explicit `imageGen.codex.model` / `.effort` in
// Settings still wins. Effort is one of providerModels' CODEX_EFFORT_LEVELS.
export const CODEX_IMAGEGEN_DEFAULT_MODEL = 'gpt-5.6-luna';
export const CODEX_IMAGEGEN_DEFAULT_EFFORT = 'low';

// The Agy mirror of the Codex pin above (#3231). An unpinned agy render used to
// resolve to the ANTIGRAVITY_CONFIGURED_DEFAULT sentinel, which resolveCliModel
// maps to null — no `--model` flag at all — so agy ran the session on whatever
// its own config selected, potentially a reasoning-heavy tier
// (claude-opus-4-6-thinking) just to relay one generate_image tool call. The
// driving agent does no creative work on the image, so the cheapest flash tier
// that reliably issues the tool call is the correct shipped default
// (empirically verified to complete a render). Agy bakes the effort ladder into
// the model id (-low/-medium/-high), so there is no separate effort pin. Same
// code-level-default rationale as Codex: reaches every install and peer with no
// migration; an explicit `imageGen.agy.model` in Settings still wins. If this
// tier ever proves flaky at issuing generate_image, escalate exactly one rung
// (gemini-3.5-flash-medium) and record why here.
export const AGY_IMAGEGEN_DEFAULT_MODEL = 'gemini-3.5-flash-low';

// The image model behind agy's generate_image tool — fixed server-side by
// Antigravity and NOT selectable by PortOS. All three channels were probed and
// closed (2026-07-29, #3231): the tool schema has no model parameter
// (Prompt/ImageName/toolSummary/toolAction/AspectRatio/ImagePaths only);
// `agy --model imagen-3-fast` errors pre-generation ("invalid model
// selection"); and a prompt directive naming imagen-3-fast rendered anyway on
// the default backend, with agy reporting it was "not able to honor" the
// request. Beware: agy itself CLAIMS the --model and prompt-directive routes
// work — it is wrong about both, so do not re-probe on its word. Exported so
// sidecars can record the image model that actually rendered (distinct from
// the agent/session model above) without hardcoding a second copy.
export const AGY_IMAGEGEN_IMAGE_MODEL = 'imagen-3.0-generate-002';

// The local runner's fallback model id when neither the request nor
// settings.imageGen.local.modelId names one (local.js's parameter default).
// Exported so provenance writers (sprite candidate sidecars, #2896) can
// record the model that actually ran without hardcoding a second copy.
export const LOCAL_IMAGEGEN_DEFAULT_MODEL = 'dev';

/**
 * Resolve the queue-capable image mode for a render request: the per-request
 * override (honored only when that backend is enabled/available), else the
 * saved dispatcher default, else codex → grok → local. External never queues.
 * Hoisted from the pipeline visual stages (#2896) so sprite renders and any
 * future queued surface share one enable-gating ladder — see issue #2881 for
 * the wider param-assembly consolidation.
 */
export function resolveQueueImageMode(requested, settings) {
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  const grokEnabled = settings?.imageGen?.grok?.enabled === true;
  const agyEnabled = settings?.imageGen?.agy?.enabled === true;
  if (requested === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (requested === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (requested === IMAGE_GEN_MODE.AGY && agyEnabled) return IMAGE_GEN_MODE.AGY;
  if (requested === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  const settingsMode = settings?.imageGen?.mode;
  if (settingsMode === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (settingsMode === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (settingsMode === IMAGE_GEN_MODE.AGY && agyEnabled) return IMAGE_GEN_MODE.AGY;
  if (settingsMode === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  if (codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (agyEnabled) return IMAGE_GEN_MODE.AGY;
  return IMAGE_GEN_MODE.LOCAL;
}

export function resolveQueueImageEditMode(requested, settings) {
  const codexEnabled = settings?.imageGen?.codex?.enabled === true;
  const grokEnabled = settings?.imageGen?.grok?.enabled === true;
  if (requested === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (requested === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (requested === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  const saved = settings?.imageGen?.mode;
  if (saved === IMAGE_GEN_MODE.CODEX && codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (saved === IMAGE_GEN_MODE.GROK && grokEnabled) return IMAGE_GEN_MODE.GROK;
  if (saved === IMAGE_GEN_MODE.LOCAL) return IMAGE_GEN_MODE.LOCAL;
  if (codexEnabled) return IMAGE_GEN_MODE.CODEX;
  if (grokEnabled) return IMAGE_GEN_MODE.GROK;
  return IMAGE_GEN_MODE.LOCAL;
}

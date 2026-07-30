import { IMAGE_GEN_MODE, RENDER_TARGET_BACKEND_AUTO, modeLabel, supportsCloudModelOverride } from '../../lib/imageGenBackends';

const DEFAULT_MODES = [IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY];

// Per-record render pin editor (#3231 Phase 3) — one row pinning a record's
// default image backend + (for model-override-capable cloud CLIs) a model.
// Mirrors the Settings → Image Gen "Render defaults" row: the model input only
// appears when the pinned backend accepts one, and ANY backend change clears
// the pinned model — model ids are namespaced per provider, and the server's
// leak guard can't catch a mode+model pinned together (see ImageGenTab).
//
// `onChange` always receives BOTH keys (`{ imageMode, imageModelId }`), with
// null for "no pin" — key-present-with-null is the intentional clear per the
// absent-vs-empty convention, so callers can PATCH the payload verbatim.
export default function RecordRenderPinRow({
  idPrefix,
  label = 'Render backend',
  imageMode = null,
  imageModelId = null,
  onChange,
  modes = DEFAULT_MODES,
  autoLabel = 'Auto (default)',
}) {
  const pinnedMode = imageMode && imageMode !== RENDER_TARGET_BACKEND_AUTO ? imageMode : '';
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[auto_auto_1fr] gap-2 sm:items-center">
      <label htmlFor={`${idPrefix}-mode`} className="text-xs font-medium text-gray-400">{label}</label>
      <select
        id={`${idPrefix}-mode`}
        value={pinnedMode}
        onChange={(e) => onChange({ imageMode: e.target.value || null, imageModelId: null })}
        className="bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent sm:w-44"
      >
        <option value="">{autoLabel}</option>
        {modes.map((m) => <option key={m} value={m}>{modeLabel(m)}</option>)}
      </select>
      {supportsCloudModelOverride(pinnedMode) ? (
        <input
          id={`${idPrefix}-model`}
          type="text"
          defaultValue={imageModelId || ''}
          key={`${pinnedMode}:${imageModelId || ''}`}
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== (imageModelId || null)) onChange({ imageMode: pinnedMode, imageModelId: v });
          }}
          placeholder="Model (optional)"
          aria-label={`${label} model`}
          className="bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent sm:w-52"
        />
      ) : <span className="hidden sm:block" />}
    </div>
  );
}

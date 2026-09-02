/**
 * Session-scoped cache of the `GET /api/video-gen/status` payload.
 *
 * That probe shells out to python and rebuilds the hardware-aware model list on
 * every call, so a cold Video Gen page load leaves the Model picker with nothing
 * to render for a second or two. Caching the last payload lets the picker paint
 * from the previous answer while the live probe revalidates behind it.
 *
 * The cached copy comes back marked `stale: true`, and callers must honour that:
 * it is trusted only for the model list and the model-shaping numbers
 * (`defaultModel`, `systemMemoryGb`, the pixel budget). Connectivity claims —
 * `connected`, `missingPackages`, the "install missing packages" banner — stay
 * keyed on the live probe, because a python interpreter the user just fixed (or
 * just broke) must never be reported from a stored answer.
 *
 * Session, not local: the model registry and the python environment both move
 * with an upgrade or an install, and a payload kept for weeks would outlive
 * both.
 */
import { safeReadJsonSession, safeWriteJsonSession } from './safeStorage.js';

// Bump the suffix when the shape the page reads out of this changes, so an
// older tab's entry is ignored rather than half-read.
export const VIDEO_GEN_STATUS_CACHE_KEY = 'portos.videoGenStatus.v1';

// Returns the cached payload with `stale: true`, or null when nothing usable is
// stored. A payload with no `models` array is worthless here — the whole point
// is painting the picker — so it reads as absent.
export const readCachedVideoGenStatus = () => {
  const cached = safeReadJsonSession(VIDEO_GEN_STATUS_CACHE_KEY);
  if (!cached || typeof cached !== 'object' || !Array.isArray(cached.models)) return null;
  return { ...cached, stale: true };
};

// Store a freshly fetched payload. Never persists the `stale` marker: what is
// written here is by definition the live answer, and it is read back as stale.
export const writeCachedVideoGenStatus = (status) => {
  if (!status || typeof status !== 'object' || !Array.isArray(status.models)) return;
  // `stale: undefined` is dropped by JSON.stringify, so a payload that somehow
  // round-tripped through the reader can't be stored as if it were fresh.
  safeWriteJsonSession(VIDEO_GEN_STATUS_CACHE_KEY, { ...status, stale: undefined });
};

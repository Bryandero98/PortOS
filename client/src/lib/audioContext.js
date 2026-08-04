// The shared lazy Web Audio AudioContext for the song-system playback stack
// (songPlayback, scorePlayback, metronome, midiPlayback). Browsers cap the
// number of live contexts (~6), and modules sharing one context also share
// one sample clock — so features that sound together (metronome + score
// synth, MIDI preview) stay aligned for free. New audio features should
// import this instead of growing another module-level singleton.
//
// Known holdouts, on purpose: components/city/audio/cityAudioEngine.js keeps
// its own context (it owns a persistent gain graph and its own — differently
// contracted — getAudioContext export), and MorseTrainer creates a per-mount
// context it close()s on unmount, which would kill a shared one for everyone
// else. Migrate those only with their graphs/lifecycles in mind.
//
// The constructor is resolved lazily so importing this module never touches
// audio APIs at load time (node-env test runs import it cleanly). Tests
// inject a fake via vi.stubGlobal('AudioContext', …) before the first call;
// the singleton then caches that fake for the test file's module registry.

let sharedCtx = null;

// --- iOS audio session ------------------------------------------------------
//
// iOS puts a page's Web Audio on the `auto` session, which behaves as *ambient*
// while no media element is playing — and an ambient session is SILENCED by the
// hardware ring/silent switch. A pure-synth page therefore looks like it is
// playing (the clock runs, the playhead scrolls) while the phone makes no sound
// at all, with nothing on screen to explain why. Declaring `playback` is the
// fix: that session ignores the switch, which is what every other platform
// already does for a backing track or a metronome.
//
// The catch, and the reason this is a SCOPED pair rather than a one-way switch:
// the session belongs to the DOCUMENT, not to an AudioContext, and `playback`
// declares the page output-only. PortOS is a single-page app, so a document
// outlives every route — declare it on the SongBook drum page and never release
// it and the Songs training views, `audioRecorder` and the voice client, all of
// which `getUserMedia` on the same document, inherit an output-only session and
// lose the microphone. So a feature holds the declaration only while it is
// actually sounding: `createLookaheadTransport`'s `audioSession` option declares
// on play and releases on teardown, which is where every caller should get this
// from rather than calling these two by hand.
//
// Safari 16.4+ only; `navigator.audioSession` is absent everywhere else and
// those browsers need nothing. Assignment is guarded because it runs from the
// play handler — a partial WebKit implementation rejecting the value must not
// take playback down with it.

/** Declare this document's iOS audio session (e.g. `'playback'`). */
export function declareAudioSession(type) {
  const session = globalThis.navigator?.audioSession;
  if (!session) return;
  try { session.type = type; } catch { /* older/partial WebKit */ }
}

/**
 * Hand the document's audio session back to the platform default. `'auto'` — not
 * a remembered previous value — because `auto` is what lets WebKit pick per
 * activity, including promoting to a record-capable session when a later view
 * opens the mic. Restoring a captured value would just re-pin whatever the last
 * feature happened to declare.
 */
export function releaseAudioSession() {
  declareAudioSession('auto');
}

/**
 * The shared AudioContext. Autoplay policies start it suspended until a user
 * gesture — callers `resumeAudioContext()` it on play, not here.
 */
export function getAudioContext() {
  if (!sharedCtx) {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/**
 * Bring `c` to `running`, awaited so the caller can schedule against a live
 * clock. Call it from a user gesture (autoplay policy) — every playback entry
 * point should go through this rather than resuming by hand.
 *
 * Gated on `state !== 'running'`, NOT on `state === 'suspended'`: iOS Safari
 * also parks a context in the non-standard `'interrupted'` state — a phone
 * call, Siri, the screen locking, another tab or app taking the audio session.
 * A suspended-only check leaves an interrupted context exactly where it is, so
 * the transport arms its scheduler against a clock that never advances and
 * "plays" in silence until the page is reloaded.
 *
 * `'closed'` is excluded on purpose: resuming a closed context rejects, and a
 * per-mount context that has already been close()d has nothing to bring back.
 */
export async function resumeAudioContext(c) {
  if (!c || c.state === 'running' || c.state === 'closed') return;
  await c.resume?.();
}

// One second of white noise, shared by every synth that needs a noise source
// (chiptune drums, the drum-kit snare/hats/cymbals). It lives beside the shared
// context for the same reason the context does: each copy is a megabyte of
// Float32 that every noise voice can read from instead of re-generating.
// Re-generated only if the sample rate changes — which for the shared context
// means never, but a per-mount context (MorseTrainer) may differ.
let noiseBuffer = null;

/** The shared white-noise buffer for `c`. Loop an AudioBufferSourceNode over it. */
export function getNoiseBuffer(c) {
  if (!noiseBuffer || noiseBuffer.sampleRate !== c.sampleRate) {
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

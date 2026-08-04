// The shared-context helpers, with an emphasis on the two iOS Safari failures
// they exist for: a context parked in `'interrupted'` and an audio session left
// ambient (silenced by the hardware ring/silent switch).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { declareAudioSession, releaseAudioSession, resumeAudioContext } from './audioContext.js';

const stubNavigator = (audioSession) => {
  vi.stubGlobal('navigator', audioSession ? { audioSession } : {});
};

// A local stub rather than `createFakeAudio`: that one binds a single starting
// state per module instance (it backs a memoized shared context), and these
// tests need a different state per case.
const fakeCtx = (state) => {
  const c = { state, resumeCalls: 0 };
  c.resume = () => { c.resumeCalls += 1; c.state = 'running'; return Promise.resolve(); };
  return c;
};

describe('audio session', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('declares the requested session so the silent switch cannot mute the synth', () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    declareAudioSession('playback');
    expect(audioSession.type).toBe('playback');
  });

  it('releases back to auto, so an output-only declaration cannot follow the user', () => {
    const audioSession = { type: 'playback' };
    stubNavigator(audioSession);
    releaseAudioSession();
    expect(audioSession.type).toBe('auto');
  });

  it('is a no-op where navigator.audioSession does not exist (every non-Safari browser)', () => {
    stubNavigator(null);
    expect(() => declareAudioSession('playback')).not.toThrow();
    expect(() => releaseAudioSession()).not.toThrow();
  });

  it('swallows a throwing setter — a partial WebKit must not take playback down', () => {
    stubNavigator({ set type(_v) { throw new TypeError('unsupported'); } });
    expect(() => declareAudioSession('playback')).not.toThrow();
  });
});

describe('resumeAudioContext', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resumes a suspended context (autoplay policy)', async () => {
    const c = fakeCtx('suspended');
    await resumeAudioContext(c);
    expect(c.resumeCalls).toBe(1);
    expect(c.state).toBe('running');
  });

  // The regression this whole helper exists for: iOS Safari parks the context in
  // `'interrupted'` after a call / Siri / the screen locking, and a gate written
  // as `state === 'suspended'` leaves it there — playback then runs silently.
  it("resumes an iOS-Safari 'interrupted' context", async () => {
    const c = fakeCtx('interrupted');
    await resumeAudioContext(c);
    expect(c.resumeCalls).toBe(1);
    expect(c.state).toBe('running');
  });

  it('leaves a running context alone', async () => {
    const c = fakeCtx('running');
    await resumeAudioContext(c);
    expect(c.resumeCalls).toBe(0);
  });

  it('never resumes a closed context (resume() would reject)', async () => {
    const c = fakeCtx('closed');
    await resumeAudioContext(c);
    expect(c.resumeCalls).toBe(0);
    expect(c.state).toBe('closed');
  });

  // The session declaration is document-wide and marks the page output-only, so
  // the shared resume must NOT make it for everyone — a capture page (sing-to-
  // score, the voice client) would lose its microphone. Output-only players opt
  // in through the transport's `audioSession` option instead.
  it('does not declare an audio session — that stays opt-in per player', async () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    await resumeAudioContext(fakeCtx('interrupted'));
    expect(audioSession.type).toBe('auto');
  });
});

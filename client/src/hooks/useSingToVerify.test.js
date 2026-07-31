import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analyserClose = vi.fn();
const trackerStop = vi.fn();
const metronomeStop = vi.fn();
const trackStop = vi.fn();
let trackerOnUpdate = null;
let metronomeOptions = null;
let clock = 1000;
const { alignMock } = vi.hoisted(() => ({ alignMock: vi.fn(() => [{ index: 0, accepted: false }]) }));

vi.mock('../lib/audioRecorder.js', () => ({
  createStreamAnalyser: vi.fn(() => ({ analyser: {}, close: analyserClose })),
}));

vi.mock('../lib/pitchDetect.js', () => ({
  createPitchTracker: vi.fn((analyser, options) => {
    trackerOnUpdate = options.onUpdate;
    return { stop: trackerStop };
  }),
}));

vi.mock('../lib/metronome.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    createMetronome: vi.fn((options) => {
      metronomeOptions = options;
      return { start: vi.fn(async () => {}), stop: metronomeStop };
    }),
  };
});

vi.mock('../lib/singToVerify.js', () => ({ alignSingToVerify: alignMock }));

import useSingToVerify, {
  VERIFY_COUNT_IN,
  VERIFY_IDLE,
  VERIFY_RECORDING,
} from './useSingToVerify.js';

const fakeStream = () => ({ getTracks: () => [{ stop: trackStop }] });

describe('useSingToVerify', () => {
  beforeEach(() => {
    analyserClose.mockClear();
    trackerStop.mockClear();
    metronomeStop.mockClear();
    trackStop.mockClear();
    alignMock.mockClear();
    trackerOnUpdate = null;
    metronomeOptions = null;
    clock = 1000;
    global.performance = { now: () => clock };
    global.navigator.mediaDevices = { getUserMedia: vi.fn(async () => fakeStream()) };
  });

  afterEach(() => vi.clearAllMocks());

  it('captures from the selected start bar and aligns rows on stop', async () => {
    const { result } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q D4q |',
    }));
    expect(result.current.phase).toBe(VERIFY_IDLE);

    await act(async () => { await result.current.start(2); });
    expect(result.current.phase).toBe(VERIFY_COUNT_IN);
    act(() => metronomeOptions.onCountInComplete());
    expect(result.current.phase).toBe(VERIFY_RECORDING);

    clock = 1100;
    act(() => trackerOnUpdate({ hz: 261.6, clarity: 0.98 }));
    clock = 1600;
    act(() => result.current.stop());

    expect(alignMock).toHaveBeenCalledWith(
      expect.any(Object),
      [{ tMs: 100, hz: 261.6, clarity: 0.98 }],
      expect.objectContaining({ bpm: 120, startBar: 2, captureEndMs: 600 }),
    );
    expect(result.current.rows).toEqual([{ index: 0, accepted: false }]);
  });

  it('tears down mic stream, analyser, tracker, and metronome on unmount', async () => {
    const { result, unmount } = renderHook(() => useSingToVerify({
      tempo: 120,
      score: 'time: 4/4\n| C4q |',
    }));
    await act(async () => { await result.current.start(1); });
    unmount();
    expect(metronomeStop).toHaveBeenCalled();
    expect(trackerStop).toHaveBeenCalled();
    expect(analyserClose).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
  });
});


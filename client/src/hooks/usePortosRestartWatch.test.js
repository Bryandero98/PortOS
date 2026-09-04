import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// The socket is a module singleton; capture its handlers so a test can fire the
// events a dying server produces without standing up socket.io.
const socketHandlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { socketHandlers.set(event, fn); },
    off: (event, fn) => { if (socketHandlers.get(event) === fn) socketHandlers.delete(event); },
    emit: () => {},
  },
}));
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), {
  success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: mockToast }));
const mockCheckHealth = vi.fn();
vi.mock('../services/api', () => ({ checkHealth: (...a) => mockCheckHealth(...a) }));

import { usePortosRestartWatch } from './usePortosRestartWatch';

// Mirrors of the hook's own constants. Duplicated deliberately: they are the
// contract this file pins, so importing them would let a change to the source
// silently move the assertions with it.
const POLL_MS = 2000;
const DISCONNECT_CONFIRM_MS = 1500;
const DOWN_WAIT_MS = 60 * 1000;
const RECOVERY_TIMEOUT_MS = 30 * 60 * 1000;
const TOAST_ID = 'portos-update-restart';

const UP = { version: '2.24.0', uptime: 120 };

let reload;

// The poll body awaits checkHealth, so every tick lands a microtask deep;
// advanceTimersByTimeAsync flushes those between timer firings.
const tick = async (ms = POLL_MS) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

const mountWatch = () => renderHook(() => usePortosRestartWatch({}));

/**
 * Drive the real pre-update sequence: sample the still-running server the way a
 * surface does before dispatching, then arm and let the watch's first poll tick
 * land. `before` is what health reports at baseline time, `after` what it
 * reports once polling starts.
 */
const armWith = async (result, { before = UP, after = before, armOpts } = {}) => {
  mockCheckHealth.mockResolvedValue(before);
  await act(async () => { await result.current.captureBaseline(); });
  mockCheckHealth.mockResolvedValue(after);
  await act(async () => { result.current.arm(armOpts); });
  await act(async () => {});
};

describe('usePortosRestartWatch', () => {
  beforeEach(() => {
    socketHandlers.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    setVisibility('visible');
    reload = vi.fn();
    vi.stubGlobal('location', { reload });
    mockCheckHealth.mockResolvedValue(UP);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setVisibility('visible');
  });

  describe('restart detection', () => {
    it('treats a changed version as the restart and reloads', async () => {
      const { result } = mountWatch();
      await armWith(result);
      expect(result.current.polling).toBe(true);

      mockCheckHealth.mockResolvedValue({ version: '2.25.0', uptime: 4 });
      await tick();

      expect(result.current.polling).toBe(false);
      expect(mockToast.success).toHaveBeenCalledWith('Updated to v2.25.0', { id: TOAST_ID });
      expect(reload).not.toHaveBeenCalled();
      await tick(1000);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reconciles a same-version restart proven by a down→up dip', async () => {
      const { result } = mountWatch();
      await armWith(result);

      // Server goes away mid-restart. Uptime on the way back stays HIGH, so the
      // dip is the only evidence — the uptime branch cannot cover for it.
      mockCheckHealth.mockResolvedValue(null);
      await tick();
      expect(result.current.polling).toBe(true);

      mockCheckHealth.mockResolvedValue({ version: '2.24.0', uptime: 900 });
      await tick();

      expect(result.current.polling).toBe(false);
      expect(mockToast.success).toHaveBeenCalledWith('Install reconciled — reloading', { id: TOAST_ID });
      await tick(1000);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reconciles a same-version restart proven by an uptime drop alone', async () => {
      // The restart too fast for a 2s poll to ever sample the down window:
      // health never fails, and the server is already back by the FIRST tick, so
      // the peak captureBaseline seeded off the still-running server is the only
      // thing the drop can be measured against.
      const { result } = mountWatch();
      await armWith(result, {
        before: { version: '2.24.0', uptime: 3600 },
        after: { version: '2.24.0', uptime: 3 },
      });

      expect(result.current.polling).toBe(false);
      expect(mockToast.success).toHaveBeenCalledWith('Install reconciled — reloading', { id: TOAST_ID });
    });

    it('carries a confirmed-down observation into the poll as restart evidence', async () => {
      // `arm({ healthDown: true })` exists so the hook does not depend on
      // `useAutoRefetch`'s `immediate: true` default to re-observe the down
      // window. Here health is UP and unchanged on every tick and there is no
      // baseline, so the carried observation is the only proof a restart
      // happened — the page adopted an update it did not start.
      const { result } = mountWatch();
      mockCheckHealth.mockResolvedValue({ version: '2.24.0', uptime: 900 });
      await act(async () => { result.current.arm({ healthDown: true }); });
      await act(async () => {});

      expect(result.current.polling).toBe(false);
      expect(mockToast.success).toHaveBeenCalledWith('Install reconciled — reloading', { id: TOAST_ID });
    });

    it('prefers the caller-supplied version over what health reports', async () => {
      // `UpdateTab` passes the version it already rendered. Health answering
      // with something else at baseline time must not overwrite it, or the
      // version-change comparison is made against the wrong "before".
      const { result } = mountWatch();
      mockCheckHealth.mockResolvedValue({ version: '2.99.0', uptime: 120 });
      await act(async () => { await result.current.captureBaseline('2.24.0'); });
      await act(async () => { result.current.arm(); });
      await act(async () => {});

      expect(result.current.polling).toBe(false);
      expect(mockToast.success).toHaveBeenCalledWith('Updated to v2.99.0', { id: TOAST_ID });
    });

    it('does not read a within-slack uptime wobble as a restart', async () => {
      // 2s below the peak — inside UPTIME_DROP_SLACK_S, i.e. clock jitter.
      const { result } = mountWatch();
      await armWith(result, {
        before: { version: '2.24.0', uptime: 3600 },
        after: { version: '2.24.0', uptime: 3598 },
      });

      expect(result.current.polling).toBe(true);
      expect(mockToast.success).not.toHaveBeenCalled();
    });
  });

  describe('phase budgets', () => {
    it('gives up at DOWN_WAIT_MS when the server never went down', async () => {
      const { result } = mountWatch();
      await armWith(result);

      await tick(DOWN_WAIT_MS - POLL_MS);
      expect(result.current.polling).toBe(true);
      expect(mockToast.error).not.toHaveBeenCalled();

      await tick(POLL_MS);

      expect(result.current.polling).toBe(false);
      expect(mockToast.error).toHaveBeenCalledWith(
        'PortOS never went down — the update may not have started', { id: TOAST_ID },
      );
    });

    it('keeps polling far past DOWN_WAIT_MS once the server is confirmed down', async () => {
      // The #6169 regression: a flat 60s ceiling measured phase 2 with phase
      // 1's ruler, so every real update timed out mid-`npm install`.
      const { result } = mountWatch();
      await armWith(result, { after: null });

      await tick(DOWN_WAIT_MS * 5);
      expect(result.current.polling).toBe(true);
      expect(mockToast.error).not.toHaveBeenCalled();

      await tick(RECOVERY_TIMEOUT_MS - DOWN_WAIT_MS * 5);

      expect(result.current.polling).toBe(false);
      expect(mockToast.error).toHaveBeenCalledWith(
        'Restart timed out — try reloading manually', { id: TOAST_ID },
      );
    });

    it('measures the budget from the FIRST arm, not the most recent one', async () => {
      const { result } = mountWatch();
      await armWith(result);

      await tick(DOWN_WAIT_MS / 2);
      await act(async () => { result.current.arm(); });
      await tick(DOWN_WAIT_MS / 2);

      // A clock restarted by the second arm would still be mid-budget here.
      expect(result.current.polling).toBe(false);
      expect(mockToast.error).toHaveBeenCalledWith(
        'PortOS never went down — the update may not have started', { id: TOAST_ID },
      );
    });

    it('lets a tick after a hidden-tab gap recognize the restart before the budget bites', async () => {
      // `useAutoRefetch` skips its tick while the tab is hidden, so a wall-clock
      // budget can lapse with zero observations. The success checks run BEFORE
      // the budget check precisely so the first tick back still wins.
      const { result } = mountWatch();
      await armWith(result);

      setVisibility('hidden');
      mockCheckHealth.mockClear();
      await tick(DOWN_WAIT_MS * 2);
      expect(mockCheckHealth).not.toHaveBeenCalled();
      expect(result.current.polling).toBe(true);

      setVisibility('visible');
      mockCheckHealth.mockResolvedValue({ version: '2.25.0', uptime: 4 });
      await tick();

      expect(mockToast.success).toHaveBeenCalledWith('Updated to v2.25.0', { id: TOAST_ID });
      expect(mockToast.error).not.toHaveBeenCalled();
    });
  });

  describe('arming from the update stream', () => {
    // No production caller arms by hand: `UpdateTab` and `useAppOperation` both
    // pass `active` and let these handlers decide.
    const mountActive = async () => {
      const view = renderHook(() => usePortosRestartWatch({ active: true }));
      await act(async () => {});
      return view;
    };

    const fireDisconnect = async () => {
      await act(async () => { socketHandlers.get('disconnect')(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(DISCONNECT_CONFIRM_MS); });
    };

    it('arms once a disconnect is confirmed unreachable', async () => {
      const { result } = await mountActive();
      mockCheckHealth.mockResolvedValue(null);

      await fireDisconnect();

      expect(result.current.polling).toBe(true);
      expect(mockToast.loading).toHaveBeenCalledWith(
        'PortOS is restarting...', expect.objectContaining({ id: TOAST_ID }),
      );
    });

    it('ignores a disconnect that leaves the server reachable', async () => {
      // PortOS is commonly used remotely over Tailscale, where a blip during
      // git-pull fires 'disconnect' on a very-much-alive server. Arming there
      // would park a bogus "restarting" toast and then fail the update with
      // "PortOS never went down" on every network hiccup.
      const { result } = await mountActive();
      mockCheckHealth.mockResolvedValue(UP);

      await fireDisconnect();

      expect(result.current.polling).toBe(false);
      expect(mockToast.loading).not.toHaveBeenCalled();
    });

    it('arms on the restarting step but not on a failed one', async () => {
      const { result } = await mountActive();

      await act(async () => { socketHandlers.get('portos:update:step')({ step: 'restarting', status: 'error' }); });
      expect(result.current.polling).toBe(false);

      await act(async () => { socketHandlers.get('portos:update:step')({ step: 'restarting' }); });
      await act(async () => {});
      expect(result.current.polling).toBe(true);
    });

    it('reports a completion that reports failure instead of arming', async () => {
      const onFailure = vi.fn();
      const { result } = renderHook(() => usePortosRestartWatch({ active: true, onFailure }));
      await act(async () => {});

      await act(async () => { socketHandlers.get('portos:update:complete')({ success: false }); });

      expect(onFailure).toHaveBeenCalledWith({ message: null });
      expect(result.current.polling).toBe(false);
    });

    it('ignores update events for an update this surface did not launch', async () => {
      // `active: false` — another tab's update, or one already reconciled here.
      const { result } = renderHook(() => usePortosRestartWatch({ active: false }));
      await act(async () => {});
      mockCheckHealth.mockResolvedValue(null);

      await act(async () => { socketHandlers.get('portos:update:step')({ step: 'restarting' }); });
      await act(async () => { socketHandlers.get('portos:update:complete')({ success: true }); });
      await fireDisconnect();

      expect(result.current.polling).toBe(false);
      expect(mockToast.loading).not.toHaveBeenCalled();
    });
  });

  describe('watch lifecycle', () => {
    it('ignores a second arm while already polling', async () => {
      const onRestart = vi.fn();
      const { result } = renderHook(() => usePortosRestartWatch({ onRestart }));

      await act(async () => { result.current.arm(); });
      await act(async () => { result.current.arm(); });
      await act(async () => {});

      expect(onRestart).toHaveBeenCalledTimes(1);
      expect(mockToast.loading).toHaveBeenCalledTimes(1);
    });

    it('stops polling health once the restart is confirmed', async () => {
      const { result } = mountWatch();
      await armWith(result);

      mockCheckHealth.mockResolvedValue({ version: '2.25.0', uptime: 4 });
      await tick();
      expect(result.current.polling).toBe(false);

      mockCheckHealth.mockClear();
      await tick(DOWN_WAIT_MS);

      expect(mockCheckHealth).not.toHaveBeenCalled();
      expect(mockToast.error).not.toHaveBeenCalled();
    });

    it('reports a failed update instead of watching for a restart', async () => {
      const onFailure = vi.fn();
      renderHook(() => usePortosRestartWatch({ active: true, onFailure }));
      await act(async () => {});

      await act(async () => { socketHandlers.get('portos:update:error')({ message: 'build failed' }); });

      expect(onFailure).toHaveBeenCalledWith({ message: 'build failed' });
      expect(mockToast.dismiss).toHaveBeenCalledWith(TOAST_ID);
      expect(mockToast.loading).not.toHaveBeenCalled();
    });

    it('subscribes to nothing when disabled', async () => {
      renderHook(() => usePortosRestartWatch({ enabled: false, active: true }));
      await act(async () => {});

      expect(socketHandlers.size).toBe(0);
    });
  });
});

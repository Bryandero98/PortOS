import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Capture the socket handlers the hook registers so the test can drive the
// shell:* protocol, and record every emit so we can assert the client half of
// the attach/detach contract. The terminal-init effect is a no-op here (its
// `terminalRef` DOM node is never attached in renderHook), so the socket/session
// logic runs without a real xterm instance.
// Hoisted so the vi.mock factory (itself hoisted to the top of the file) can
// reference the same objects the tests drive.
const { handlers, emitted, socketMock } = vi.hoisted(() => {
  const handlers = new Map();
  const emitted = [];
  const socketMock = {
    connected: true,
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: (event, ...args) => { emitted.push([event, ...args]); },
  };
  return { handlers, emitted, socketMock };
});
vi.mock('../services/socket', () => ({ default: socketMock, getSocket: () => socketMock }));
vi.mock('../components/ThemeContext', () => ({
  useThemeContext: () => ({ themeId: 'test', theme: { mode: 'night' } }),
}));
const { readFileAsBase64, sendShellImage, toastMock } = vi.hoisted(() => ({
  readFileAsBase64: vi.fn(),
  sendShellImage: vi.fn(),
  toastMock: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../utils/fileUpload', () => ({ readFileAsBase64 }));
vi.mock('../services/api', () => ({ sendShellImage }));
vi.mock('../components/ui/Toast', () => ({ default: toastMock }));

import { useShellSession, MAX_SESSIONS } from './useShellSession.js';

const wrapper = ({ children }) => (
  <MemoryRouter initialEntries={['/shell']}>{children}</MemoryRouter>
);
const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });
const lastEmit = (event) => [...emitted].reverse().find(([e]) => e === event);
const session = (id, over = {}) => ({ sessionId: id, attached: false, external: false, createdAt: Date.now(), ...over });
// Render with `list` live and the view attached to `activeId`.
const attachedTo = (activeId, list) => {
  const rendered = renderHook(() => useShellSession({}), { wrapper });
  fire('shell:sessions', list);
  fire('shell:attached', { sessionId: activeId, bufferedOutput: '' });
  return rendered;
};

describe('useShellSession', () => {
  beforeEach(() => { handlers.clear(); emitted.length = 0; socketMock.connected = true; });
  afterEach(cleanup);

  it('requests the session list on mount when the socket is already connected', () => {
    renderHook(() => useShellSession({}), { wrapper });
    expect(emitted).toContainEqual(['shell:list']);
  });

  it('auto-starts a fresh session when the list is empty and the user is not idle', () => {
    renderHook(() => useShellSession({}), { wrapper });
    fire('shell:sessions', []);
    expect(lastEmit('shell:start')).toBeTruthy();
  });

  it('activates a started session and marks it connected', () => {
    const { result } = renderHook(() => useShellSession({}), { wrapper });
    fire('shell:sessions', []);          // → startSession, pending target 'new'
    fire('shell:started', { sessionId: 'abc' });
    expect(result.current.activeSessionId).toBe('abc');
    expect(result.current.connected).toBe(true);
  });

  it('sends Ctrl+B to the active terminal session', () => {
    const { result } = renderHook(() => useShellSession({}), { wrapper });
    fire('shell:sessions', []);
    fire('shell:started', { sessionId: 'abc' });
    act(() => result.current.sendCtrlB());
    expect(lastEmit('shell:input')).toEqual(['shell:input', { sessionId: 'abc', data: '\x02' }]);
  });

  // cd goes over its own event carrying the PATH — the server owns the quoting,
  // because only it knows whether the session runs cmd.exe, PowerShell, or a
  // POSIX shell (the hard-coded POSIX form was unusable on Windows).
  it('sends the folder path over shell:cd rather than composing a cd command', () => {
    const { result } = renderHook(() => useShellSession({}), { wrapper });
    fire('shell:sessions', []);
    fire('shell:started', { sessionId: 'abc' });
    act(() => result.current.sendCd('I:\\code\\example-app'));
    expect(lastEmit('shell:cd')).toEqual(['shell:cd', { sessionId: 'abc', path: 'I:\\code\\example-app' }]);
  });

  it('ignores a shell:attached whose id does not match the pending target (strict-equality guard)', () => {
    const { result } = renderHook(() => useShellSession({}), { wrapper });
    // First load with one free survivor → auto-attach to s1 (claim:true), pending target 's1'.
    fire('shell:sessions', [session('s1')]);
    expect(lastEmit('shell:attach')).toEqual(['shell:attach', { sessionId: 's1', claim: true }]);
    // A stale/mismatched attach response must not activate.
    fire('shell:attached', { sessionId: 'other', bufferedOutput: '' });
    expect(result.current.activeSessionId).toBeNull();
    // The matching response activates.
    fire('shell:attached', { sessionId: 's1', bufferedOutput: '' });
    expect(result.current.activeSessionId).toBe('s1');
  });

  it('drops the active view when the server detaches the displayed session', () => {
    const { result } = renderHook(() => useShellSession({}), { wrapper });
    fire('shell:sessions', [session('s1')]);
    fire('shell:attached', { sessionId: 's1', bufferedOutput: '' });
    expect(result.current.activeSessionId).toBe('s1');
    fire('shell:detached', { sessionId: 's1', reason: 'attached-elsewhere' });
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.connected).toBe(false);
  });

  it('surfaces derived counts and the active session', () => {
    const { result } = renderHook(() => useShellSession({}), { wrapper });
    fire('shell:sessions', [session('s1'), session('run1', { external: true })]);
    fire('shell:attached', { sessionId: 's1', bufferedOutput: '' });
    expect(result.current.interactiveCount).toBe(1);
    expect(result.current.liveRunCount).toBe(1);
    expect(result.current.isLiveRun).toBe(false);
    expect(result.current.activeSession?.sessionId).toBe('s1');
  });

  it('exports the shell session cap', () => {
    expect(MAX_SESSIONS).toBe(20);
  });

  // Losing the session you are looking at must not strand you on a dead terminal
  // while other live shells sit one click away in the tab strip. Every trigger —
  // user close, exit, takeover — goes through the one recovery path.
  describe('recovering the displayed session', () => {
    it('activates the next free shell when the user stops the active session', () => {
      const { result } = attachedTo('s2', [session('s1'), session('s2')]);
      act(() => result.current.stopSession());
      expect(lastEmit('shell:stop')).toEqual(['shell:stop', { sessionId: 's2' }]);
      // Auto-pick, so claim:true — a multi-tab race must not boot another tab.
      expect(lastEmit('shell:attach')).toEqual(['shell:attach', { sessionId: 's1', claim: true }]);
      fire('shell:attached', { sessionId: 's1', bufferedOutput: '' });
      expect(result.current.activeSessionId).toBe('s1');
      expect(result.current.connected).toBe(true);
    });

    it('activates the next free shell when the user kills the active tab', () => {
      const { result } = attachedTo('s2', [session('s1'), session('s2')]);
      act(() => result.current.killOtherSession('s2'));
      expect(lastEmit('shell:attach')).toEqual(['shell:attach', { sessionId: 's1', claim: true }]);
    });

    it('leaves the view alone when the killed tab is not the active one', () => {
      const { result } = attachedTo('s2', [session('s1'), session('s2')]);
      emitted.length = 0;
      act(() => result.current.killOtherSession('s1'));
      expect(lastEmit('shell:attach')).toBeUndefined();
      expect(result.current.activeSessionId).toBe('s2');
    });

    // A session that dies on its own reaches the same recovery, and the takeover
    // path must not depend on the server's follow-up broadcast to recover.
    it('attaches to a free survivor when the displayed session exits on its own', () => {
      const { result } = attachedTo('s2', [session('s1'), session('s2')]);
      emitted.length = 0;
      fire('shell:exit', { sessionId: 's2', code: 0 });
      expect(result.current.activeSessionId).toBeNull();
      expect(lastEmit('shell:attach')).toEqual(['shell:attach', { sessionId: 's1', claim: true }]);
    });

    it('attaches to a free survivor when another tab takes the displayed session', () => {
      const { result } = attachedTo('s2', [session('s1'), session('s2')]);
      emitted.length = 0;
      fire('shell:detached', { sessionId: 's2', reason: 'attached-elsewhere' });
      expect(result.current.activeSessionId).toBeNull();
      expect(lastEmit('shell:attach')).toEqual(['shell:attach', { sessionId: 's1', claim: true }]);
    });

    it('stays put when nothing free is left to switch to', () => {
      // s1 is driving another tab and run1 is an external TUI run — neither is a
      // safe auto-pick, so the user genuinely has nowhere to land.
      const { result } = attachedTo('s2', [
        session('s1', { attached: true }),
        session('run1', { external: true }),
        session('s2'),
      ]);
      emitted.length = 0;
      act(() => result.current.stopSession());
      expect(lastEmit('shell:attach')).toBeUndefined();
      expect(result.current.activeSessionId).toBeNull();
      expect(result.current.connected).toBe(false);
    });

    // A reconnect re-runs the initial-load branch, which is the one that spawns.
    // Respawning there would make Stop a no-op, so the close has to suppress it.
    it('does not spawn a replacement on reconnect after the user stopped their last shell', () => {
      const { result } = attachedTo('s1', [session('s1')]);
      act(() => result.current.stopSession());
      emitted.length = 0;
      fire('connect');
      fire('shell:sessions', []);
      expect(lastEmit('shell:start')).toBeUndefined();
    });

    // Same reconnect, but a free shell exists: adoption is not what's suppressed.
    it('does adopt a free shell on reconnect after a stop', () => {
      const { result } = attachedTo('s1', [session('s1')]);
      act(() => result.current.stopSession());
      emitted.length = 0;
      fire('connect');
      fire('shell:sessions', [session('s9')]);
      expect(lastEmit('shell:attach')).toEqual(['shell:attach', { sessionId: 's9', claim: true }]);
    });

    // The flag a close leaves behind suppresses spawning, NOT adoption: a shell
    // freed by another tab afterwards must still land, or the user is stuck on
    // "Disconnected" with a live shell one click away.
    it('adopts a shell that frees up after a close left nothing to switch to', () => {
      const { result } = attachedTo('s2', [session('s1', { attached: true }), session('s2')]);
      act(() => result.current.stopSession());
      emitted.length = 0;
      fire('shell:sessions', [session('s1')]);   // the other tab let go of s1
      expect(lastEmit('shell:attach')).toEqual(['shell:attach', { sessionId: 's1', claim: true }]);
    });
  });

  // Restart asks for a *replacement* shell, so it must not run the survivor
  // adoption path even when another shell is free.
  describe('restartSession', () => {
    it('starts a fresh shell rather than adopting a survivor', () => {
      vi.useFakeTimers();
      const { result } = attachedTo('s2', [session('s1'), session('s2')]);
      emitted.length = 0;
      act(() => result.current.restartSession());
      expect(lastEmit('shell:stop')).toEqual(['shell:stop', { sessionId: 's2' }]);
      expect(lastEmit('shell:attach')).toBeUndefined();
      // The reserved 'new' pending slot keeps the post-stop broadcast from
      // adopting s1 into the gap.
      fire('shell:sessions', [session('s1')]);
      expect(lastEmit('shell:attach')).toBeUndefined();
      act(() => { vi.advanceTimersByTime(1000); });
      expect(lastEmit('shell:start')).toBeTruthy();
      vi.useRealTimers();
    });

    it('aborts the deferred start when the user switches sessions inside the window', () => {
      vi.useFakeTimers();
      const { result } = attachedTo('s2', [session('s1'), session('s2')]);
      act(() => result.current.restartSession());
      emitted.length = 0;
      act(() => result.current.switchToSession('s1'));
      act(() => { vi.advanceTimersByTime(1000); });
      expect(lastEmit('shell:start')).toBeUndefined();
      expect(lastEmit('shell:attach')).toEqual(['shell:attach', { sessionId: 's1' }]);
      vi.useRealTimers();
    });
  });

  // sendImage goes over HTTP, not the shell:* socket protocol — socket.io's 1MB
  // frame limit can't carry a photo, and it needs a result.
  describe('sendImage', () => {
    const photo = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });

    const activeHook = () => {
      const rendered = renderHook(() => useShellSession({}), { wrapper });
      fire('shell:sessions', []);
      fire('shell:started', { sessionId: 'abc' });
      return rendered;
    };

    beforeEach(() => {
      readFileAsBase64.mockReset().mockResolvedValue('Zm9v');
      sendShellImage.mockReset().mockResolvedValue({ sessionId: 'abc', filename: 'shell-aa11bb22-photo.jpg' });
      toastMock.error.mockReset();
      toastMock.success.mockReset();
    });

    it('posts the bytes to the active session and resolves true', async () => {
      const { result } = activeHook();
      await expect(result.current.sendImage(photo, 'what is this?')).resolves.toBe(true);

      // `silent` because this hook owns the error toast — otherwise the user sees two.
      expect(sendShellImage).toHaveBeenCalledWith(
        'abc',
        { data: 'Zm9v', filename: 'photo.jpg', message: 'what is this?' },
        { silent: true },
      );
      expect(toastMock.success).toHaveBeenCalled();
    });

    it('resolves false and toasts when the server rejects the send', async () => {
      sendShellImage.mockRejectedValue(new Error('Session not found'));
      const { result } = activeHook();
      await expect(result.current.sendImage(photo, 'hi')).resolves.toBe(false);
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('Session not found'));
      expect(toastMock.success).not.toHaveBeenCalled();
    });

    it('resolves false without posting when the file cannot be read', async () => {
      readFileAsBase64.mockRejectedValue(new Error('boom'));
      const { result } = activeHook();
      await expect(result.current.sendImage(photo, 'hi')).resolves.toBe(false);
      expect(sendShellImage).not.toHaveBeenCalled();
    });

    it('refuses to send when there is no active session', async () => {
      const { result } = renderHook(() => useShellSession({}), { wrapper });
      await expect(result.current.sendImage(photo, 'hi')).resolves.toBe(false);
      expect(readFileAsBase64).not.toHaveBeenCalled();
    });

    // Mid-switch the terminal has been cleared and the pending target is another
    // session — a send here would land in the session the user is leaving.
    it('refuses to send while an attach is in flight', async () => {
      const { result } = renderHook(() => useShellSession({}), { wrapper });
      fire('shell:sessions', [session('s1')]);
      fire('shell:attached', { sessionId: 's1', bufferedOutput: '' });
      act(() => result.current.switchToSession('s2'));
      await expect(result.current.sendImage(photo, 'hi')).resolves.toBe(false);
      expect(readFileAsBase64).not.toHaveBeenCalled();
    });
  });
});

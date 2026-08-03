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

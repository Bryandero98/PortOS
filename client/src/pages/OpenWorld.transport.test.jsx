import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { installVoiceHotkeySpy } from '../test/voiceHotkeySpy';

// Same stubbing strategy as OpenWorld.fastTravel.test.jsx: the 3D scene and the HUD are
// replaced with inert divs so the page's keyboard WIRING can be exercised in jsdom.
vi.mock('../components/openworld/OpenWorldScene', () => ({ default: () => <div data-testid="scene" /> }));
vi.mock('../components/openworld/OpenWorldHud', () => ({ default: () => null }));
vi.mock('../components/openworld/OpenWorldPhotoOverlay', () => ({ default: () => null }));
vi.mock('../components/openworld/OpenWorldPlaybackOverlay', () => ({ default: () => null }));
vi.mock('../components/openworld/OpenWorldSettingsDrawer', () => ({ default: () => null }));

vi.mock('../hooks/useOpenWorldData', () => ({
  useOpenWorldData: () => ({
    apps: [], cosAgents: [], cosStatus: {}, eventLogs: [], agentMap: new Map(),
    reviewCounts: {}, instances: {}, systemHealth: null, notificationCounts: {},
    backupStatus: null, cosTasks: [], healthMetrics: null, voiceState: null,
    character: null, aiActivity: null, loading: false, connected: true,
  }),
}));

// The playback hook is the surface under test: the page binds its transport keys only
// while `active`, and the spies below record what each key reached.
const playback = vi.hoisted(() => ({
  active: true, currentFrame: null, snapshots: [], frameIndex: 0, stats: null,
  playing: false, speed: 1, loading: false, error: null,
  enter: vi.fn(), exit: vi.fn(), seek: vi.fn(), step: vi.fn(),
  togglePlay: vi.fn(), cycleSpeed: vi.fn(),
}));
vi.mock('../hooks/useOpenWorldPlayback', () => ({ useOpenWorldPlayback: () => playback }));
vi.mock('../hooks/useOpenWorldAudio', () => ({ default: () => ({ playSfx: vi.fn(), isAudioReady: false }) }));
vi.mock('../hooks/useAutoRefetch', () => ({ useAutoRefetch: () => ({ data: null }) }));
vi.mock('../services/api', () => ({
  getCosQuickSummary: vi.fn(async () => null),
  getCosActivityCalendar: vi.fn(async () => null),
  getGoals: vi.fn(async () => null),
  getChronotype: vi.fn(async () => null),
  getMemoryGraph: vi.fn(async () => null),
  getBrainInbox: vi.fn(async () => null),
  getOpenWorldIntrospection: vi.fn(async () => null),
  getMySprintTickets: vi.fn(async () => []),
}));

const OpenWorld = (await import('./OpenWorld')).default;

const renderPage = () => render(
  <MemoryRouter initialEntries={['/openworld']}>
    <Routes><Route path="/openworld" element={<OpenWorld />} /></Routes>
  </MemoryRouter>
);

describe('OpenWorld playback transport keys', () => {
  const voiceHotkey = installVoiceHotkeySpy();

  beforeEach(() => {
    playback.active = true;
    playback.exit.mockClear();
    playback.step.mockClear();
    playback.togglePlay.mockClear();
    localStorage.clear();
  });

  it('toggles play on Space without leaking the key to the global voice hotkey', () => {
    renderPage();

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(playback.togglePlay).toHaveBeenCalledTimes(1);
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('claims Escape and the arrow keys too', () => {
    renderPage();

    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft' }); });
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }); });
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });

    expect(playback.step.mock.calls).toEqual([[-1], [1]]);
    expect(playback.exit).toHaveBeenCalledTimes(1);
    expect(voiceHotkey()).not.toHaveBeenCalled();
  });

  it('lets unhandled keys through to app-global listeners', () => {
    renderPage();

    act(() => { fireEvent.keyDown(document.body, { key: 'j' }); });

    expect(voiceHotkey()).toHaveBeenCalledTimes(1);
    expect(playback.togglePlay).not.toHaveBeenCalled();
  });

  it('ignores Space typed into a text field, leaving the transport alone', () => {
    const { container } = renderPage();
    const input = document.createElement('input');
    container.appendChild(input);
    input.focus();

    act(() => { fireEvent.keyDown(input, { key: ' ', code: 'Space' }); });

    expect(playback.togglePlay).not.toHaveBeenCalled();
  });

  it('yields the transport keys to an open dialog layer', () => {
    // The settings drawer renders aria-modal and closes on its own Escape handler; the
    // transport must not swallow that keystroke out from under it (useKeyCapture's
    // enabledInDialog default).
    const { container } = renderPage();
    const drawer = document.createElement('div');
    drawer.setAttribute('aria-modal', 'true');
    container.appendChild(drawer);

    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(playback.exit).not.toHaveBeenCalled();
    expect(playback.togglePlay).not.toHaveBeenCalled();
    expect(voiceHotkey()).toHaveBeenCalledTimes(2);
  });

  it('binds nothing while playback is inactive', () => {
    playback.active = false;
    renderPage();

    act(() => { fireEvent.keyDown(document.body, { key: ' ', code: 'Space' }); });

    expect(playback.togglePlay).not.toHaveBeenCalled();
    expect(voiceHotkey()).toHaveBeenCalledTimes(1);
  });
});

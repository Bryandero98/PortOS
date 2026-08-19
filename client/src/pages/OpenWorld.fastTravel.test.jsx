import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';

// The 3D scene and the cockpit HUD are stubbed: this suite is about the page's fast-travel
// WIRING (route param → scene props, M → panel, pick → navigate + teleport), not about
// rendering WebGL in jsdom. The scene stub records the props it received so the assertions
// can read them directly.
const sceneProps = { current: null };
vi.mock('../components/city/CityScene', () => ({
  default: (props) => {
    sceneProps.current = props;
    return <div data-testid="scene" />;
  },
}));
vi.mock('../components/city/CityHud', () => ({
  default: ({ onOpenFastTravel, activeRegion }) => (
    <div>
      <button type="button" onClick={onOpenFastTravel}>hud-fast-travel</button>
      <span data-testid="hud-region">{activeRegion?.id || 'none'}</span>
    </div>
  ),
}));
vi.mock('../components/city/CityScanlines', () => ({ default: () => null }));
vi.mock('../components/city/CityPhotoOverlay', () => ({ default: () => null }));
vi.mock('../components/city/CityPlaybackOverlay', () => ({ default: () => null }));
vi.mock('../components/city/CitySettingsDrawer', () => ({ default: () => null }));

vi.mock('../hooks/useCityData', () => ({
  useCityData: () => ({
    apps: [], cosAgents: [], cosStatus: {}, eventLogs: [], agentMap: new Map(),
    reviewCounts: {}, instances: {}, systemHealth: null, notificationCounts: {},
    backupStatus: null, cosTasks: [], healthMetrics: null, voiceState: null,
    character: null, aiActivity: null, loading: false, connected: true,
  }),
}));
vi.mock('../hooks/useCityPlayback', () => ({
  useCityPlayback: () => ({
    active: false, currentFrame: null, snapshots: [], frameIndex: 0, stats: null,
    playing: false, speed: 1, loading: false, error: null,
    enter: vi.fn(), exit: vi.fn(), seek: vi.fn(), step: vi.fn(),
    togglePlay: vi.fn(), cycleSpeed: vi.fn(),
  }),
}));
vi.mock('../hooks/useCityAudio', () => ({ default: () => ({ playSfx: vi.fn(), isAudioReady: false }) }));
vi.mock('../hooks/useAutoRefetch', () => ({ useAutoRefetch: () => ({ data: null }) }));
// Only the endpoints this page polls. `useAutoRefetch` is stubbed above so none of them
// actually fire — the mock exists to keep the real api module (and its socket import) out
// of the jsdom run.
vi.mock('../services/api', () => ({
  getCosQuickSummary: vi.fn(async () => null),
  getCosActivityCalendar: vi.fn(async () => null),
  getGoals: vi.fn(async () => null),
  getChronotype: vi.fn(async () => null),
  getMemoryGraph: vi.fn(async () => null),
  getBrainInbox: vi.fn(async () => null),
  getCityIntrospection: vi.fn(async () => null),
  getMySprintTickets: vi.fn(async () => []),
}));

const OpenWorld = (await import('./OpenWorld')).default;

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}</span>;
}

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocationProbe />
    <Routes>
      <Route path="/openworld" element={<OpenWorld />} />
      <Route path="/openworld/region/:regionId" element={<OpenWorld />} />
      <Route path="/brain/inbox" element={<div>brain page</div>} />
    </Routes>
  </MemoryRouter>
);

describe('OpenWorld — fast travel wiring', () => {
  beforeEach(() => {
    sceneProps.current = null;
    localStorage.clear();
  });

  it('hands the scene no region on the plain overview route', () => {
    renderAt('/openworld');
    expect(sceneProps.current.focusedRegion).toBeNull();
  });

  it('resolves the :regionId route param into a region for the camera', () => {
    renderAt('/openworld/region/memory');
    expect(sceneProps.current.focusedRegion.id).toBe('memory');
    // Geography comes from the master town plan, not from the route.
    expect(sceneProps.current.focusedRegion.anchor).toBeDefined();
  });

  it('hands the scene a null region for an unknown id rather than crashing', () => {
    renderAt('/openworld/region/atlantis');
    expect(sceneProps.current.focusedRegion).toBeNull();
  });

  it('defaults to the Vibes world style, and reflects it in the scene settings', () => {
    renderAt('/openworld');
    expect(sceneProps.current.settings.worldStyle).toBe('vibes');
    expect(sceneProps.current.settings.timeOfDay).toMatch(/^vibes/);
    expect(sceneProps.current.palette.lowPoly).toBe(true);
  });

  it('honors a stored cyber style, restoring the original preset pair', () => {
    localStorage.setItem('portos-city-settings', JSON.stringify({ worldStyle: 'cyber' }));
    renderAt('/openworld');
    expect(sceneProps.current.settings.worldStyle).toBe('cyber');
    expect(['noon', 'sunset']).toContain(sceneProps.current.settings.timeOfDay);
    expect(sceneProps.current.palette.lowPoly).toBe(false);
  });

  it('opens fast travel with M and warps to the picked region', () => {
    renderAt('/openworld');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });

    fireEvent.click(screen.getByLabelText('Travel to Memory Quarter'));

    expect(screen.getByTestId('path')).toHaveTextContent('/openworld/region/memory');
    expect(sceneProps.current.focusedRegion.id).toBe('memory');
  });

  it('opens fast travel from the HUD button too', () => {
    renderAt('/openworld');
    fireEvent.click(screen.getByText('hud-fast-travel'));
    expect(screen.getByLabelText('Travel to Memory Quarter')).toBeInTheDocument();
  });

  it('closes fast travel with Escape', () => {
    renderAt('/openworld');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    expect(screen.getByLabelText('Search regions')).toBeInTheDocument();

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByLabelText('Search regions')).not.toBeInTheDocument();
  });

  it('does not teleport the player while flying the overview camera', () => {
    renderAt('/openworld');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByLabelText('Travel to Memory Quarter'));
    // Exploration mode is off, so there is no player rig to move.
    expect(sceneProps.current.playerTeleport).toBeNull();
  });

  it('teleports the player when warping on foot', () => {
    localStorage.setItem('portos-city-settings', JSON.stringify({ explorationMode: true }));
    renderAt('/openworld');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByLabelText('Travel to Memory Quarter'));

    const teleport = sceneProps.current.playerTeleport;
    expect(teleport).toMatchObject({ x: expect.any(Number), z: expect.any(Number) });
    expect(teleport.token).toBe(1);
  });

  it('bumps the teleport token when the same region is picked twice', () => {
    localStorage.setItem('portos-city-settings', JSON.stringify({ explorationMode: true }));
    renderAt('/openworld');

    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByLabelText('Travel to Memory Quarter'));
    expect(sceneProps.current.playerTeleport.token).toBe(1);

    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByLabelText('Travel to Memory Quarter'));
    // Same destination, new warp — a plain {x,z} identity check would have swallowed this.
    expect(sceneProps.current.playerTeleport.token).toBe(2);
  });

  it('tells the HUD which region is active', () => {
    renderAt('/openworld/region/data-harbor');
    expect(screen.getByTestId('hud-region')).toHaveTextContent('data-harbor');
  });

  it('opens the PortOS page a region stands for', () => {
    renderAt('/openworld/region/memory');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByTitle('Open /brain/inbox'));
    expect(screen.getByTestId('path')).toHaveTextContent('/brain/inbox');
  });

  it('returns to the overview from the panel', () => {
    renderAt('/openworld/region/memory');
    act(() => { fireEvent.keyDown(window, { key: 'm' }); });
    fireEvent.click(screen.getByText('OVERVIEW'));
    expect(screen.getByTestId('path')).toHaveTextContent('/openworld');
    expect(sceneProps.current.focusedRegion).toBeNull();
  });
});

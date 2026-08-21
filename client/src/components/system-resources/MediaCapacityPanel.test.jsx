import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({ getInstances: vi.fn() }));
vi.mock('../../services/api.js', () => api);

const MediaCapacityPanel = (await import('./MediaCapacityPanel.jsx')).default;

const media = (overrides = {}) => ({
  gpu: { cudaStatus: 'available', laneBusy: true, laneKind: 'video' },
  lanes: {
    gpu: { running: 1, queued: 2, limit: 1 },
    cloud: { running: 0, queued: 0, limit: 1 },
    remote: { running: 3, queued: 0, limit: 20 },
  },
  byKind: {
    video: { running: 1, queued: 2 },
    image: { running: 0, queued: 0 },
    audio: { running: 3, queued: 0 },
    training: { running: 0, queued: 0 },
  },
  totals: { running: 4, queued: 2 },
  ...overrides,
});

const providerPeer = (overrides = {}) => ({
  id: 'peer-1',
  name: 'render-box',
  status: 'online',
  mediaProvider: { enabled: true, audioModels: [{ engine: 'minimax', modelId: 'music-3' }] },
  mediaProviderStatus: {
    checkedAt: new Date().toISOString(),
    state: 'ready',
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
    snapshot: {
      queue: { running: 1, queued: 0, totalActive: 1, maxQueuedJobs: 4, accepting: true },
      capabilities: [],
    },
  },
  ...overrides,
});

const renderPanel = (props = {}) => render(
  <MemoryRouter>
    <MediaCapacityPanel media={media()} {...props} />
  </MemoryRouter>,
);

describe('MediaCapacityPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getInstances.mockResolvedValue({ peers: [] });
  });

  it('shows each lane’s occupancy against its configured limit', async () => {
    renderPanel();
    expect(await screen.findByText('Local GPU')).toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getByText('3/20')).toBeInTheDocument();
    expect(screen.getByText('4 running · 2 queued')).toBeInTheDocument();
  });

  it('reports queue depth per kind, skipping idle kinds', async () => {
    renderPanel();
    expect(await screen.findByText('video: 1/2')).toBeInTheDocument();
    expect(screen.getByText('audio: 3/0')).toBeInTheDocument();
    expect(screen.queryByText(/^image:/)).not.toBeInTheDocument();
  });

  // available / absent / unknown are three distinct claims — a failed probe must
  // never be rendered as "this machine has no GPU".
  it.each([
    ['available', 'CUDA available'],
    ['absent', 'no CUDA device'],
    ['unknown', 'CUDA unknown'],
  ])('renders the %s CUDA state as its own label', async (cudaStatus, label) => {
    renderPanel({ media: media({ gpu: { cudaStatus, laneBusy: false, laneKind: null } }) });
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('renders an unknown state rather than an idle one when the report is missing', async () => {
    renderPanel({ media: null });
    expect(await screen.findByText(/Media-lane capacity is unavailable/)).toBeInTheDocument();
    expect(screen.getByText('CUDA unknown')).toBeInTheDocument();
    expect(screen.queryByText('Local GPU')).not.toBeInTheDocument();
  });

  it('lists an opted-in peer provider with its readiness and queue', async () => {
    api.getInstances.mockResolvedValue({ peers: [providerPeer()] });
    renderPanel();
    expect(await screen.findByText('render-box')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('1 running · 0 queued · 1/4 slots')).toBeInTheDocument();
  });

  it('shows an expired snapshot as stale with its remedy, not as ready', async () => {
    api.getInstances.mockResolvedValue({
      peers: [providerPeer({
        mediaProviderStatus: {
          checkedAt: new Date(Date.now() - 600_000).toISOString(),
          state: 'ready',
          freshUntil: new Date(Date.now() - 300_000).toISOString(),
          snapshot: { queue: { running: 0, queued: 0, totalActive: 0, maxQueuedJobs: 4, accepting: true }, capabilities: [] },
        },
      })],
    });
    renderPanel();
    expect(await screen.findByText('stale')).toBeInTheDocument();
    expect(screen.queryByText('ready')).not.toBeInTheDocument();
    expect(screen.getByText(/last capacity snapshot expired/i)).toBeInTheDocument();
  });

  it('omits a peer that is not enabled as a media provider', async () => {
    api.getInstances.mockResolvedValue({
      peers: [providerPeer({ id: 'p2', name: 'laptop', mediaProvider: { enabled: false } })],
    });
    renderPanel();
    expect(await screen.findByText(/No peer is enabled as a media provider/)).toBeInTheDocument();
    expect(screen.queryByText('laptop')).not.toBeInTheDocument();
  });

  // A failed read and a genuinely peerless install must not render identically.
  it('distinguishes a failed peer read from having no providers', async () => {
    api.getInstances.mockRejectedValue(new Error('offline'));
    renderPanel();
    expect(await screen.findByText(/provider readiness is unknown/i)).toBeInTheDocument();
    expect(screen.queryByText(/No peer is enabled as a media provider/)).not.toBeInTheDocument();
  });
});

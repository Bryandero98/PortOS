import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// ── Mock API calls ───────────────────────────────────────────────────────────
vi.mock('../services/api', () => ({
  listMediaCollections: vi.fn().mockResolvedValue([
    { id: 'col-1', name: 'Alpha', items: [{ kind: 'image', ref: 'img1.png', addedAt: '2024-01-01' }] },
    { id: 'col-2', name: 'Beta', items: [] },
    {
      id: 'col-3',
      name: 'Creative Director: Nightly Surreal Landscapes — 2026-08-01',
      description: 'Auto-created for project col-3',
      items: [],
    },
  ]),
  createMediaCollection: vi.fn(),
  deleteMediaCollection: vi.fn(),
  listVideoHistory: vi.fn().mockResolvedValue([]),
  listImageGallery: vi.fn().mockResolvedValue([]),
}));

// ── Mock useSyncIntegrity ────────────────────────────────────────────────────
const statusById = new Map([['col-1', 'in-parity'], ['col-2', 'diverged']]);
vi.mock('../hooks/useSyncIntegrity', () => ({
  useSyncIntegrity: () => ({
    statusById,
    noSyncingPeers: false,
    integrityUnavailable: false,
    loading: false,
    error: null,
    refresh: vi.fn(),
    byPeer: new Map(),
  }),
  // Mirror the real precedence helper so badge-status assertions stay valid.
  syncBadgeStatus: (sync, recordId) => (
    sync.noSyncingPeers
      ? 'not-syncing'
      : (sync.statusById.get(recordId) ?? (sync.integrityUnavailable ? 'unknown' : undefined))
  ),
}));

// ── Mock buildUnsortedCollection ─────────────────────────────────────────────
vi.mock('../lib/unsorted', () => ({
  buildUnsortedCollection: () => ({
    id: '__unsorted__',
    name: 'Unsorted',
    items: [{ kind: 'image', ref: 'loose.png', addedAt: '2024-01-02' }],
    synthetic: true,
  }),
}));

import MediaCollections from './MediaCollections';

function renderPage(entry = '/media/collections') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <MediaCollections />
    </MemoryRouter>,
  );
}

describe('MediaCollections', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders non-empty collection names after loading', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
  });

  it('renders a SyncBadge per visible non-synthetic collection row', async () => {
    renderPage('/media/collections?empty=1');
    await waitFor(() => screen.getByText('Alpha'));
    // 'in-parity' badge on col-1, 'diverged' on col-2
    expect(screen.getByText('In sync')).toBeInTheDocument();
    expect(screen.getByText('Diverged')).toBeInTheDocument();
  });

  it('does not render a SyncBadge for the synthetic Unsorted collection', async () => {
    renderPage('/media/collections?empty=1');
    await waitFor(() => screen.getByText('Alpha'));
    // Unsorted is synthetic — only the real collections with a known sync
    // status get a badge (col-1 in-parity, col-2 diverged; col-3 has none).
    const badges = screen.getAllByRole('button', { name: /in sync|diverged|assets missing|local only|on peer only|not syncing/i });
    expect(badges.length).toBe(2);
  });

  it('hides empty collections by default and says how many it hid', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.getByText(/2 empty collections hidden/)).toBeInTheDocument();
  });

  it('reveals the empty collections from the "Show" affordance', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Beta')).toBeInTheDocument();
  });

  it('toggles empty collections back in from the Hide empty checkbox', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    await user.click(screen.getByLabelText('Hide empty'));
    expect(await screen.findByText('Beta')).toBeInTheDocument();
  });

  it('honours ?empty=1 so a shared filtered URL restores the view', async () => {
    renderPage('/media/collections?empty=1');
    expect(await screen.findByText('Beta')).toBeInTheDocument();
  });

  it('filters by the search box', async () => {
    const user = userEvent.setup();
    renderPage('/media/collections?empty=1');
    await waitFor(() => screen.getByText('Alpha'));
    await user.type(screen.getByLabelText('Search collections'), 'beta');
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('lifts the shared auto-creator prefix into a badge and keeps the name tail visible', async () => {
    renderPage('/media/collections?empty=1');
    await waitFor(() => screen.getByText('Alpha'));
    expect(screen.getByText('Creative Director')).toBeInTheDocument();
    // The trailing date survives — an end-clip would have eaten it.
    expect(screen.getByText(/2026-08-01$/)).toBeInTheDocument();
    // The full name is still available on hover.
    expect(screen.getByTitle('Creative Director: Nightly Surreal Landscapes — 2026-08-01')).toBeInTheDocument();
  });

  it('offers the three sort options', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    const select = screen.getByLabelText('Sort collections');
    expect([...select.options].map((o) => o.textContent))
      .toEqual(['Recently updated', 'Name', 'Item count']);
  });
});

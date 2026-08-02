import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

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

// Surfaces the live URL search string and lets a test drive an EXTERNAL
// navigation (Back/Forward, a ⌘K deep-link) while the page stays mounted — the
// only way to exercise the adopt-the-URL effect.
function RouteProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="search-string">{location.search}</div>
      <button type="button" onClick={() => navigate('/media/collections?q=alpha')}>external nav</button>
    </>
  );
}

function renderPage(entry = '/media/collections') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <MediaCollections />
      <RouteProbe />
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

  it('hydrates the search box, sort, and empty toggle from the URL', async () => {
    renderPage('/media/collections?q=a&sort=name&empty=1');
    await waitFor(() => screen.getByText('Alpha'));
    expect(screen.getByLabelText('Search collections')).toHaveValue('a');
    expect(screen.getByLabelText('Sort collections')).toHaveValue('name');
    expect(screen.getByLabelText('Hide empty')).not.toBeChecked();
    // `q=a` matches Alpha and Beta but not Unsorted, and empty=1 keeps Beta.
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Unsorted')).not.toBeInTheDocument();
  });

  it('mirrors the typed query into the URL after the debounce', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    await user.type(screen.getByLabelText('Search collections'), 'beta');
    await waitFor(
      () => expect(screen.getByTestId('search-string')).toHaveTextContent('q=beta'),
      { timeout: 3000 },
    );
  });

  it('writes the sort to the URL and drops the param at the default', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    await user.selectOptions(screen.getByLabelText('Sort collections'), 'name');
    await waitFor(() => expect(screen.getByTestId('search-string')).toHaveTextContent('sort=name'));
    await user.selectOptions(screen.getByLabelText('Sort collections'), 'updated');
    await waitFor(() => expect(screen.getByTestId('search-string')).not.toHaveTextContent('sort='));
  });

  it('adopts an externally-changed ?q= while the page stays mounted', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    await user.click(screen.getByRole('button', { name: 'external nav' }));
    await waitFor(() => expect(screen.getByLabelText('Search collections')).toHaveValue('alpha'));
  });

  it('says every match is empty rather than claiming there was no match', async () => {
    // `beta` matches exactly one collection, which "Hide empty" then removes —
    // reporting "no match" here would send the user hunting for a real record.
    renderPage('/media/collections?q=beta');
    await waitFor(() => screen.getByText(/1 empty collection hidden/));
    expect(screen.getByText(/Every collection here is empty/)).toBeInTheDocument();
    expect(screen.queryByText(/No collections match that search/)).not.toBeInTheDocument();
  });

  it('reveals the empties after creating a collection so the new one is visible', async () => {
    const { createMediaCollection } = await import('../services/api');
    createMediaCollection.mockResolvedValue({ id: 'col-4', name: 'Fresh Bucket', items: [] });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    await user.type(screen.getByLabelText('New collection name'), 'Fresh Bucket');
    await user.click(screen.getByRole('button', { name: /create/i }));
    // A brand-new collection is always empty; without the reveal it would be
    // filtered straight back out and the create would look like it failed.
    expect(await screen.findByText('Fresh Bucket')).toBeInTheDocument();
  });

  it('offers the three sort options', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alpha'));
    const select = screen.getByLabelText('Sort collections');
    expect([...select.options].map((o) => o.textContent))
      .toEqual(['Recently updated', 'Name', 'Item count']);
  });
});

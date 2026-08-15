/**
 * Creative Commission detail page — render-history project resolution (#4148).
 *
 * The page used to pull EVERY Creative Director project just to index the ones
 * its runs reference, so its cost scaled with the install's total project count.
 * These cases pin the batch-by-id fetch: only the referenced ids go out, the
 * whole-list route is never touched, and an id the batch can't resolve still
 * degrades to the status-only card.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getCommission: vi.fn(),
  updateCommission: vi.fn(),
  deleteCommission: vi.fn(),
  submitCommissionFeedback: vi.fn(),
  runCommissionNow: vi.fn(),
  getCreativeDirectorProjectsByIds: vi.fn(() => Promise.resolve([])),
  listCreativeDirectorProjects: vi.fn(() => Promise.resolve([])),
}));
// The config form loads model catalogs on mount — out of scope here, and it
// would put real requests behind the assertions about which projects load.
vi.mock('../components/creative-commission/CommissionConfigForm.jsx', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// ProjectPreview reaches into the media/job graph; the assertions here are about
// which projects resolved, so stub it down to an identifiable marker.
vi.mock('../components/creative-director/ProjectPreview.jsx', () => ({
  default: ({ project }) => <div data-testid={`preview-${project.id}`} />,
}));

import * as api from '../services/api';
import CreativeCommissionDetail from './CreativeCommissionDetail';

const COMMISSION = {
  id: 'cc-1',
  name: 'Example commission',
  enabled: true,
  targetAbility: 'video',
  schedule: { kind: 'cron', cron: '0 9 * * *' },
  assignment: {},
  feedback: [],
  runs: [
    { id: 'run-1', projectId: 'cd-1', status: 'started', ranAt: '2026-05-01T10:00:00.000Z' },
    { id: 'run-2', projectId: 'cd-2', status: 'started', ranAt: '2026-05-02T10:00:00.000Z' },
    // Same project as run-1 — the batch must de-duplicate it.
    { id: 'run-3', projectId: 'cd-1', status: 'started', ranAt: '2026-05-03T10:00:00.000Z' },
    // No render at all — contributes no id.
    { id: 'run-4', projectId: null, status: 'skipped', ranAt: '2026-05-04T10:00:00.000Z' },
  ],
};

const renderPage = async () => {
  render(<MemoryRouter><CreativeCommissionDetail /></MemoryRouter>);
  await screen.findByRole('heading', { name: COMMISSION.name });
};

describe('CreativeCommissionDetail render-history project resolution (#4148)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCommission.mockResolvedValue(COMMISSION);
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([]);
  });

  it('fetches only the projects its runs reference, never the whole list', async () => {
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([
      { id: 'cd-1', name: 'P1' }, { id: 'cd-2', name: 'P2' },
    ]);
    await renderPage();

    await waitFor(() => expect(api.getCreativeDirectorProjectsByIds).toHaveBeenCalled());
    const [ids] = api.getCreativeDirectorProjectsByIds.mock.calls[0];
    expect([...ids].sort()).toEqual(['cd-1', 'cd-2']);
    expect(api.listCreativeDirectorProjects).not.toHaveBeenCalled();

    await waitFor(() => expect(screen.getAllByTestId('preview-cd-1')).toHaveLength(2));
    expect(screen.getAllByTestId('preview-cd-2')).toHaveLength(1);
  });

  it('skips the request entirely when no run references a project', async () => {
    api.getCommission.mockResolvedValue({
      ...COMMISSION,
      runs: [{ id: 'run-9', projectId: null, status: 'skipped', ranAt: '2026-05-04T10:00:00.000Z' }],
    });
    await renderPage();

    await screen.findByText('no render');
    expect(api.getCreativeDirectorProjectsByIds).not.toHaveBeenCalled();
    expect(api.listCreativeDirectorProjects).not.toHaveBeenCalled();
  });

  it('degrades a run whose project the batch could not resolve to a status-only card', async () => {
    api.getCreativeDirectorProjectsByIds.mockResolvedValue([{ id: 'cd-1', name: 'P1' }]);
    await renderPage();

    await waitFor(() => expect(screen.getAllByTestId('preview-cd-1')).toHaveLength(2));
    // cd-2 was requested but is gone (pruned project) — no preview, and the
    // placeholder must read "unavailable" rather than staying on "loading…".
    expect(screen.queryByTestId('preview-cd-2')).toBeNull();
    expect(screen.getByText('render unavailable')).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

vi.mock('../services/apiCreativeDirector.js', () => ({
  getCreativeDirectorProject: vi.fn(),
  deleteCreativeDirectorProject: vi.fn(),
  startCreativeDirectorProject: vi.fn(),
  pauseCreativeDirectorProject: vi.fn(),
  stopCreativeDirectorProject: vi.fn(),
  resumeCreativeDirectorProject: vi.fn(),
}));
vi.mock('../services/apiAgents.js', () => ({ getCosAgents: vi.fn(() => Promise.resolve([])) }));
vi.mock('../hooks/useMediaJobProgress', () => ({ default: () => ({ status: 'unknown', error: null }) }));
vi.mock('../components/creative-director/OverviewTab.jsx', () => ({ default: () => <div>Overview content</div> }));
vi.mock('../components/creative-director/TreatmentTab.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/SegmentsTab.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/PlanTab.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/RunsTab.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/ActiveAgentsBanner.jsx', () => ({ default: () => null }));
vi.mock('../components/creative-director/CreativeDirectorModelsDrawer.jsx', () => ({ default: () => null }));
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import * as cdApi from '../services/apiCreativeDirector.js';
import CreativeDirectorDetail from './CreativeDirectorDetail';

const PROJECT = {
  id: 'cd-example',
  name: 'Example project',
  status: 'draft',
  treatment: null,
};

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

const renderPage = async () => {
  render(
    <MemoryRouter initialEntries={['/creative-director/cd-example/overview']}>
      <LocationProbe />
      <Routes>
        <Route path="/creative-director/:id/:tab" element={<CreativeDirectorDetail />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: PROJECT.name });
};

describe('CreativeDirectorDetail project deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cdApi.getCreativeDirectorProject.mockResolvedValue(PROJECT);
    cdApi.deleteCreativeDirectorProject.mockResolvedValue({ ok: true });
  });

  it('requires confirmation before deleting the project', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: `Delete project ${PROJECT.name}` }));

    expect(cdApi.deleteCreativeDirectorProject).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete', exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('deletes the project and returns to the Creative Director list', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByRole('button', { name: `Delete project ${PROJECT.name}` }));
    await user.click(screen.getByRole('button', { name: 'Delete', exact: true }));

    await waitFor(() => expect(cdApi.deleteCreativeDirectorProject).toHaveBeenCalledWith(PROJECT.id, { silent: true }));
    expect(screen.getByTestId('location')).toHaveTextContent('/creative-director');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../services/api', () => ({
  addLoomEpisode: vi.fn(),
  addLoomNode: vi.fn(),
  deleteLoomEpisode: vi.fn(),
  getLoom: vi.fn(),
  getPipelineSeries: vi.fn(),
  updateLoomEpisode: vi.fn(),
  updateLoom: vi.fn(),
  updateLoomNode: vi.fn(),
  weaveLoomEpisode: vi.fn(),
}));

// The graph canvas and the rails are irrelevant to the header — stub them so
// the suite exercises the loom → series backlink and nothing else.
vi.mock('../components/fableloom/LoomCanvas', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomEpisodeOutline', () => ({ default: ({ episode }) => <div data-testid="episode-outline">{episode.title}</div> }));
vi.mock('../components/fableloom/LoomNodeEditor', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomPlayPanel', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomSettingsDrawer', () => ({ default: () => <div /> }));
vi.mock('../components/fableloom/LoomSeriesPlan', () => ({ default: () => <div>Series planning workspace</div> }));
vi.mock('../components/fableloom/LoomValidationPanel', () => ({ default: () => <div /> }));

import * as api from '../services/api';
import FableLoomStory from './FableLoomStory';

const loom = (fields = {}) => ({
  id: 'loom-1',
  name: 'Example Loom',
  format: 'prose',
  universeId: null,
  seriesId: null,
  episodes: [],
  ...fields,
});

const episode = (fields = {}) => ({
  id: 'ep-1',
  number: 1,
  title: 'The First Door',
  synopsis: 'A choice waits in the dark.',
  startNodeId: 'node-1',
  nodes: [
    { id: 'node-1', title: 'Threshold', prose: 'You stand before the first door.', transitions: [] },
  ],
  ...fields,
});

const renderEditor = () => render(
  <MemoryRouter initialEntries={['/fableloom/loom-1']}>
    <Routes>
      <Route path="/fableloom/:loomId" element={<FableLoomStory />} />
      <Route path="/fableloom/:loomId/:episodeId" element={<FableLoomStory />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getLoom.mockResolvedValue(loom());
});

describe('FableLoomStory navigation and series backlink', () => {
  it('opens an empty loom in the series plan before asking for episodes', async () => {
    renderEditor();

    expect(await screen.findByText('Series planning workspace')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Series plan' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Add the first episode' })).toBeNull();
  });

  it('still opens the first episode for an established loom', async () => {
    api.getLoom.mockResolvedValue(loom({ episodes: [episode()] }));
    renderEditor();

    expect(await screen.findByRole('tab', { name: '1. The First Door' }))
      .toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Series planning workspace')).toBeNull();
  });

  it('links back to the series a loom is soft-linked to', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-1' }));
    api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: 'Example Series' });
    renderEditor();

    const link = await screen.findByRole('link', { name: /Example Series/ });
    expect(link).toHaveAttribute('href', '/pipeline/series/ser-1');
    expect(api.getPipelineSeries).toHaveBeenCalledWith('ser-1', { silent: true });
  });

  it('renders no chip (not a dead link) when the linked series has been deleted', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-gone' }));
    api.getPipelineSeries.mockRejectedValue(new Error('Series not found'));
    renderEditor();

    await screen.findByText('Example Loom');
    await waitFor(() => expect(api.getPipelineSeries).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /series/i })).toBeNull();
  });

  it('falls back to a placeholder for a series with no name', async () => {
    api.getLoom.mockResolvedValue(loom({ seriesId: 'ser-1' }));
    api.getPipelineSeries.mockResolvedValue({ id: 'ser-1', name: '' });
    renderEditor();

    expect(await screen.findByRole('link', { name: /Untitled series/ }))
      .toHaveAttribute('href', '/pipeline/series/ser-1');
  });

  it('never asks for a series when the loom is standalone', async () => {
    renderEditor();
    await screen.findByText('Example Loom');
    expect(api.getPipelineSeries).not.toHaveBeenCalled();
  });

  it('keeps series planning outside the episode tabs at a dedicated URL', async () => {
    render(
      <MemoryRouter initialEntries={['/fableloom/loom-1/plan']}>
        <Routes>
          <Route path="/fableloom/:loomId/:episodeId" element={<FableLoomStory />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Series planning workspace')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Series plan' })).toBeInTheDocument();
  });
});

describe('FableLoomStory episode outline route', () => {
  it('renders the outline view at its dedicated URL without mounting the graph editor', async () => {
    api.getLoom.mockResolvedValue(loom({ episodes: [episode()] }));
    render(
      <MemoryRouter initialEntries={['/fableloom/loom-1/ep-1/outline']}>
        <Routes>
          <Route path="/fableloom/:loomId/:episodeId/outline" element={<FableLoomStory view="outline" />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('episode-outline')).toHaveTextContent('The First Door');
    expect(screen.getByRole('tab', { name: 'Outline' })).toHaveAttribute('aria-selected', 'true');
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActiveProcessingWidget from './ActiveProcessingWidget';

const { mockGetActiveProcessing, mockCancelMediaJob } = vi.hoisted(() => ({
  mockGetActiveProcessing: vi.fn(),
  mockCancelMediaJob: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../services/api', () => ({
  getActiveProcessing: mockGetActiveProcessing,
  cancelMediaJob: mockCancelMediaJob,
}));

vi.mock('../../hooks/useAutoRefetch', () => ({
  useAutoRefetch: (fetchFn) => {
    fetchFn();
    return { data: mockGetActiveProcessing.mock.results.at(-1)?.value, loading: false };
  },
}));

const renderWidget = () => render(<MemoryRouter><ActiveProcessingWidget /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());

describe('ActiveProcessingWidget', () => {
  it('shows an idle GPU link when nothing is active', () => {
    mockGetActiveProcessing.mockReturnValue({ gpu: { status: 'available' }, jobs: [], extras: {}, agents: {} });
    renderWidget();
    expect(screen.getByText('Live activity')).toBeInTheDocument();
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /GPU ready/ })).toHaveAttribute('href', '/system-resources/overview');
  });

  it('summarizes active work and links each lane to its destination', () => {
    mockGetActiveProcessing.mockReturnValue({
      gpu: { status: 'available', laneBusy: true, gpus: [{ utilizationPercent: 42 }] },
      jobs: [
        { id: 'image-1', kind: 'image', status: 'running', progress: 0.5, startedAt: new Date().toISOString(), params: { prompt: 'Example image' } },
        { id: 'audio-1', kind: 'audio', status: 'queued', position: 2, params: { musicStudio: { title: 'Example track' } } },
      ],
      extras: { imageTo3d: [{ id: 'model-1', name: 'Example mesh' }] },
      agents: { active: 2, queued: 1 },
    });
    renderWidget();
    expect(screen.getByText('5 active')).toBeInTheDocument();
    expect(screen.getByText('Example image')).toBeInTheDocument();
    expect(screen.getByText('Example track')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open image activity' })).toHaveAttribute('href', '/media/image');
    expect(screen.getByRole('link', { name: 'Open audio activity' })).toHaveAttribute('href', '/media/history?type=audio');
    expect(screen.getByRole('link', { name: /Chief of Staff agents/ })).toHaveAttribute('href', '/cos/agents');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('cancels a live job from its row', async () => {
    mockGetActiveProcessing.mockReturnValue({
      gpu: { status: 'available' },
      jobs: [{ id: 'image-1', kind: 'image', status: 'running', progress: 0.5, startedAt: new Date().toISOString(), params: { prompt: 'Example image' } }],
      extras: {},
      agents: {},
    });
    const user = userEvent.setup();
    renderWidget();
    await user.click(screen.getByRole('button', { name: 'Cancel Example image' }));
    expect(mockCancelMediaJob).toHaveBeenCalledWith('image-1', { silent: true });
  });
});

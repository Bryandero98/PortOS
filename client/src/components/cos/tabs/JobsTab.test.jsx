import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCosJobs: vi.fn(),
  triggerCosJob: vi.fn(),
  updateCosJob: vi.fn(),
  toggleCosJob: vi.fn(),
  deleteCosJob: vi.fn(),
  getJobHistory: vi.fn(),
  getApps: vi.fn(),
  getProviders: vi.fn(),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const JobsTab = (await import('./JobsTab')).default;

const mockJob = {
  id: 'job-1',
  name: 'Test Job',
  description: 'Test job description',
  type: 'agent',
  interval: 'daily',
  intervalMs: 86400000,
  priority: 'MEDIUM',
  autonomyLevel: 'medium',
  enabled: true,
  promptTemplate: 'Do test things',
  category: 'General',
  lastRun: null,
  runCount: 0
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosJobs.mockResolvedValue({ jobs: [mockJob] });
  api.getJobHistory.mockResolvedValue({ runs: [] });
  api.triggerCosJob.mockResolvedValue({ success: true });
  api.updateCosJob.mockResolvedValue({ job: mockJob });
  api.getApps.mockResolvedValue([]);
  api.getProviders.mockResolvedValue({ providers: [] });
});

describe('JobsTab / JobCard Run Now disable behavior (#4036)', () => {
  it('enables the Run now button when not editing and disables it while editing', async () => {
    render(<JobsTab apps={[]} providers={[]} />);

    // Wait for jobs to load
    await waitFor(() => expect(screen.getByText('Test Job')).toBeInTheDocument());

    const runNowButton = screen.getByRole('button', { name: 'Run now' });
    expect(runNowButton).not.toBeDisabled();
    expect(runNowButton).toHaveAttribute('title', 'Run now');

    // Click edit button
    const editButton = screen.getByRole('button', { name: 'Edit' });
    fireEvent.click(editButton);

    // Now Run now button should be disabled
    expect(runNowButton).toBeDisabled();
    expect(runNowButton).toHaveAttribute('title', 'Save changes before running job');

    // Attempting to click Run now while editing should not trigger job
    fireEvent.click(runNowButton);
    expect(api.triggerCosJob).not.toHaveBeenCalled();

    // Saving edits should re-enable the button
    const saveButton = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveButton);

    await waitFor(() => expect(runNowButton).not.toBeDisabled());
    expect(runNowButton).toHaveAttribute('title', 'Run now');
  });
});

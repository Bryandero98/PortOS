import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import JobsTab from './JobsTab';

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
  it('enables the Run now button when not editing and disables it while editing (save flow)', async () => {
    render(<JobsTab apps={[]} providers={[]} />);

    // Wait for jobs to load
    await waitFor(() => expect(screen.getByText('Test Job')).toBeInTheDocument());

    const runNowButton = screen.getByRole('button', { name: 'Run now' });
    expect(runNowButton).not.toBeDisabled();
    expect(runNowButton).toHaveAttribute('title', 'Run now');

    // Click edit button
    const editButton = screen.getByRole('button', { name: 'Edit' });
    fireEvent.click(editButton);

    // Now Run now button should be disabled with updated title & aria-label
    const disabledRunNowButton = screen.getByRole('button', { name: 'Save changes before running job' });
    expect(disabledRunNowButton).toBeDisabled();
    expect(disabledRunNowButton).toHaveAttribute('title', 'Save changes before running job');

    // Attempting to click Run now while editing should not trigger job
    fireEvent.click(disabledRunNowButton);
    expect(api.triggerCosJob).not.toHaveBeenCalled();

    // Saving edits should re-enable the button
    const saveButton = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(saveButton);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' })).not.toBeDisabled());
  });

  it('re-enables the Run now button when exiting edit mode via Cancel', async () => {
    render(<JobsTab apps={[]} providers={[]} />);

    await waitFor(() => expect(screen.getByText('Test Job')).toBeInTheDocument());

    const editButton = screen.getByRole('button', { name: 'Edit' });
    fireEvent.click(editButton);

    expect(screen.getByRole('button', { name: 'Save changes before running job' })).toBeDisabled();

    // Click Cancel button
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    const reEnabledRunNow = screen.getByRole('button', { name: 'Run now' });
    expect(reEnabledRunNow).not.toBeDisabled();
  });
});

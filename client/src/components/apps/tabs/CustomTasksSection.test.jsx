import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCosJobs: vi.fn(),
  triggerCosJob: vi.fn(),
  getSettings: vi.fn()
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

import CustomTasksSection from './CustomTasksSection';

const task = {
  id: 'job-1',
  appId: 'app-1',
  name: 'Example Task',
  enabled: true,
  type: 'agent',
  interval: 'daily',
  runCount: 0
};

describe('CustomTasksSection trigger outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosJobs.mockResolvedValue({ jobs: [task] });
    api.getSettings.mockResolvedValue({ timezone: 'UTC' });
  });

  it('surfaces a skipped trigger without claiming the task ran', async () => {
    api.triggerCosJob.mockResolvedValue({
      success: false,
      status: 'skipped',
      reason: 'Task was not queued'
    });
    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Task was not queued'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('treats an existing equivalent task as an informational skip', async () => {
    api.triggerCosJob.mockResolvedValue({
      success: true,
      status: 'skipped',
      reason: 'An equivalent task is already queued',
      duplicate: true
    });
    render(<CustomTasksSection appId="app-1" appName="Example App" />);
    await screen.findByText('Example Task');

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('An equivalent task is already queued'));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mock = vi.hoisted(() => ({
  getDailyActions: vi.fn(),
  updateInstanceFeature: vi.fn(),
}));

vi.mock('../services/api', () => mock);

import { toast, Toaster } from '../components/ui/Toast';
import { useEngagementReminderToast } from './useEngagementReminderToast';

function Harness() {
  useEngagementReminderToast();
  return null;
}

describe('useEngagementReminderToast', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mock.getDailyActions.mockResolvedValue({
      today: '2026-08-24',
      actions: [{
        id: 'daily-post',
        type: 'post_engagement',
        title: 'Daily POST is waiting',
        detail: 'No POST activity today.',
        link: '/post/launcher',
        featureId: 'post',
        featureLabel: 'POST',
      }],
    });
    mock.updateInstanceFeature.mockResolvedValue({ features: [{ id: 'post', enabled: false }] });
  });

  afterEach(() => {
    act(() => toast.dismiss());
    cleanup();
  });

  it('keeps the action link and offers a per-instance disable button', async () => {
    render(<MemoryRouter><Harness /><Toaster /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: 'Open action' });
    expect(link).toHaveAttribute('href', '/post/launcher');
    expect(screen.getByRole('button', { name: 'Disable on this instance' })).toBeInTheDocument();
  });

  it('disables the feature and closes the reminder', async () => {
    render(<MemoryRouter><Harness /><Toaster /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable on this instance' }));

    await waitFor(() => expect(mock.updateInstanceFeature).toHaveBeenCalledWith('post', false, { silent: true }));
    expect(screen.queryByText('Daily POST is waiting')).toBeNull();
    expect(await screen.findByText('POST disabled on this instance')).toBeInTheDocument();
  });
});

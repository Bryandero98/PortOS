import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import CodeReviewersTab from './CodeReviewersTab';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  getCodeReviewDefaults: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../../hooks/useReviewerModelOptions', () => ({
  default: () => ({ ctxById: {} }),
}));

vi.mock('../ui/Toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('CodeReviewersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading state initially and populates panel when fetch succeeds', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['codex'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'consensus',
      reviewerApplies: false,
    });

    render(<CodeReviewersTab />);

    expect(screen.getByText('Loading defaults…')).toBeInTheDocument();

    expect(await screen.findByText('Save defaults')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load code review defaults.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save defaults' })).not.toBeDisabled();
    expect(api.getCodeReviewDefaults).toHaveBeenCalledWith({ silent: true });
  });

  it('renders error banner with Retry button and disables Save button when fetch rejects', async () => {
    api.getCodeReviewDefaults.mockRejectedValue(new Error('Network error'));

    render(<CodeReviewersTab />);

    expect(await screen.findByText('Failed to load code review defaults.')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toBeInTheDocument();

    const saveBtn = screen.getByRole('button', { name: 'Save defaults' });
    expect(saveBtn).toBeDisabled();
  });

  it('re-fetches defaults when Retry button is clicked and enables Save button on success', async () => {
    api.getCodeReviewDefaults
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        reviewers: ['codex'],
        usernames: [],
        optionalReviewers: [],
        reviewerMaxRounds: {},
        stopMode: 'consensus',
        reviewerApplies: false,
      });

    render(<CodeReviewersTab />);

    expect(await screen.findByText('Failed to load code review defaults.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save defaults' })).toBeDisabled();

    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByText('Failed to load code review defaults.')).not.toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Save defaults' })).not.toBeDisabled();
    expect(api.getCodeReviewDefaults).toHaveBeenCalledTimes(2);
  });

  it('handles save when Save defaults button is clicked', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['codex'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'consensus',
      reviewerApplies: false,
    });
    api.updateSettings.mockResolvedValue({ success: true });

    render(<CodeReviewersTab />);

    const saveBtn = await screen.findByRole('button', { name: 'Save defaults' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalled();
    });
  });
});

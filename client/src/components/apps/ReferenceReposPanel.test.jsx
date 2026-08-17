import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  listReferenceRepos: vi.fn(),
  getAppWorkTracker: vi.fn(),
  checkReferenceRepo: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import ReferenceReposPanel from './ReferenceReposPanel';

const reference = {
  id: 'ref-1',
  name: 'Example upstream',
  repoUrl: 'https://example.com/upstream.git',
  branch: 'main',
  status: 'stale',
  lastError: 'git fetch failed',
  lastCheckedAt: '2026-08-16T00:00:00.000Z',
  lastReviewedSha: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listReferenceRepos.mockResolvedValue({ referenceRepos: [reference] });
  api.getAppWorkTracker.mockResolvedValue({ resolved: 'github' });
  api.checkReferenceRepo.mockResolvedValue({
    schemaVersion: 1,
    fetchedAt: '2026-08-15T00:00:00.000Z',
    head: 'a'.repeat(40),
    commitCount: 1,
    commits: [{ sha: 'a'.repeat(40), author: 'Alice', date: '2026-08-15T00:00:00.000Z', subject: 'saved commit' }],
    stale: true,
    staleAgeMs: 86_400_000,
    error: { code: 'REFERENCE_REPO_GIT_FAILED', message: 'temporary outage' },
  });
});

afterEach(cleanup);

describe('ReferenceReposPanel stale checks', () => {
  it('renders the stale state and keeps the saved snapshot visibly distinct after a failed check', async () => {
    render(<ReferenceReposPanel appId="app-1" appName="Example App" />);
    expect(await screen.findByText('stale')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /check/i }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/latest check failed/i);
    expect(notice).toHaveTextContent(/temporary outage/i);
    expect(notice).toHaveTextContent(/1d 0h old/i);
    expect(notice).toHaveTextContent(/retry before marking this reference reviewed/i);
    await waitFor(() => expect(api.checkReferenceRepo).toHaveBeenCalledWith('app-1', 'ref-1', { silent: true }));
  });
});

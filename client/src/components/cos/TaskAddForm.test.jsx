import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import TaskAddForm from './TaskAddForm';

const api = vi.hoisted(() => ({
  getCosPopularTemplates: vi.fn(),
  getCodeReviewDefaults: vi.fn()
}));

vi.mock('../../services/api', () => api);

describe('TaskAddForm responsive layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosPopularTemplates.mockResolvedValue({ templates: [] });
    api.getCodeReviewDefaults.mockResolvedValue(null);
  });

  it('keeps PR completion controls full-width on mobile', async () => {
    render(
      <TaskAddForm
        providers={[]}
        apps={[{
          id: 'example-app',
          name: 'Example App',
          repoPath: 'example.com/repo',
          defaultOpenPR: true,
          defaultPrCompletion: 'review-then-merge'
        }]}
        defaultApp="example-app"
        onTaskAdded={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Reviewers (in order):')).toBeInTheDocument());

    const options = screen.getByRole('form', { name: 'Add new task' }).querySelector('div.grid');
    expect(options).toHaveClass('grid-cols-1');
    expect(options).not.toHaveClass('grid-cols-2');
  });
});

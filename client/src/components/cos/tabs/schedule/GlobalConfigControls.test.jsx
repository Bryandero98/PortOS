import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// The two hooks are the component's only API callers — stub them so the test
// exercises the config controls, not the network.
vi.mock('../../../../hooks/useCodeReviewDefaults', () => ({
  useCodeReviewDefaults: () => ({
    reviewers: ['copilot'],
    usernames: [],
    optionalReviewers: [],
    reviewerMaxRounds: {},
    stopMode: 'clean',
    reviewerApplies: false,
  }),
}));
vi.mock('../../../../hooks/useReviewerModelOptions', () => ({
  default: () => ({ optionsByReviewer: {}, freeText: {}, unavailable: {}, loaded: true }),
}));
vi.mock('../../ReviewerPicker', () => ({
  default: () => <div data-testid="reviewer-picker" />,
}));

import GlobalConfigControls from './GlobalConfigControls';

const BASE_CONFIG = {
  type: 'daily',
  enabled: true,
  providerId: null,
  model: null,
  effort: null,
  prompt: 'do the thing',
  status: {},
};

function renderControls({ taskMetadata, onUpdate = vi.fn(), taskType = 'feature-ideas' } = {}) {
  render(
    <GlobalConfigControls
      taskType={taskType}
      config={{ ...BASE_CONFIG, taskMetadata }}
      onUpdate={onUpdate}
      onTrigger={() => {}}
      onReset={() => {}}
      providers={[]}
      apps={[]}
      updating={false}
      setUpdating={() => {}}
      allTaskTypes={['feature-ideas']}
    />
  );
  return onUpdate;
}

const prSelect = () => screen.queryByLabelText('After opening PR');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GlobalConfigControls — After opening PR', () => {
  it('hides the selector when the task does not open a PR', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: false } });
    expect(prSelect()).not.toBeInTheDocument();
  });

  it('defaults an unpinned task to the app-default option', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: true } });
    expect(prSelect()).toHaveValue('');
    expect(screen.getByTestId('reviewer-picker')).toBeInTheDocument();
  });

  it('shows a legacy reviewLoop task the policy it actually runs under', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: true, reviewLoop: true } });
    expect(prSelect()).toHaveValue('review-then-merge');
  });

  // Keeps unrelated keys, and drops the legacy reviewLoop bit so it can't
  // outvote the pin the user just made.
  it('persists the picked policy into taskMetadata', () => {
    const onUpdate = renderControls({ taskMetadata: { useWorktree: true, openPR: true, simplify: true, reviewLoop: true } });
    fireEvent.change(prSelect(), { target: { value: 'merge-on-green' } });
    expect(onUpdate).toHaveBeenCalledWith('feature-ideas', {
      taskMetadata: { useWorktree: true, openPR: true, simplify: true, prCompletion: 'merge-on-green' },
    });
  });

  it('clears the pin (back to the app default) when App default is picked', () => {
    const onUpdate = renderControls({ taskMetadata: { useWorktree: true, openPR: true, prCompletion: 'leave-open' } });
    expect(prSelect()).toHaveValue('leave-open');
    fireEvent.change(prSelect(), { target: { value: '' } });
    expect(onUpdate).toHaveBeenCalledWith('feature-ideas', {
      taskMetadata: { useWorktree: true, openPR: true },
    });
  });

  it.each(['merge-on-green', 'leave-open'])('hides the reviewer picker for %s', (prCompletion) => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: true, prCompletion } });
    expect(screen.queryByTestId('reviewer-picker')).not.toBeInTheDocument();
  });

  it('keeps the reviewer picker for review-then-merge', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: true, prCompletion: 'review-then-merge' } });
    expect(screen.getByTestId('reviewer-picker')).toBeInTheDocument();
  });

  it('keeps the reviewer picker for a legacy reviewLoop task that opens no PR', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: false, reviewLoop: true } });
    expect(screen.getByTestId('reviewer-picker')).toBeInTheDocument();
  });
});

describe('GlobalConfigControls — branch-reconcile batch size', () => {
  it('shows the safe default and persists a selected branch batch', () => {
    const onUpdate = renderControls({ taskType: 'branch-reconcile', taskMetadata: { cleanupMerged: true } });
    const select = screen.getByLabelText('Branches per agent');
    expect(select).toHaveValue('3');
    fireEvent.change(select, { target: { value: '5' } });
    expect(onUpdate).toHaveBeenCalledWith('branch-reconcile', {
      taskMetadata: { cleanupMerged: true, branchesPerAgent: 5 }
    });
  });
});

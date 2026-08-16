import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { typeSettled } from '../../../test/settledInput';

vi.mock('../../../services/api', () => ({
  submitCosAgentFeedback: vi.fn(),
  getCosAgent: vi.fn(),
  getCosAgentPrompt: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const copyToClipboard = vi.fn();
vi.mock('../../../lib/clipboard', () => ({
  copyToClipboard: (...args) => copyToClipboard(...args),
}));

import * as api from '../../../services/api';
import AgentCard from './AgentCard';

const agent = {
  id: 'agent-example',
  taskId: 'task-example',
  status: 'completed',
  startedAt: '2026-07-13T09:00:00.000Z',
  completedAt: '2026-07-13T10:00:00.000Z',
  metadata: { taskDescription: 'Example task', taskType: 'user' },
  result: { success: true, duration: 3600000 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentCard feedback', () => {
  it('hides the rating UI for a completed scheduled/autopilot agent (taskType internal)', () => {
    const internalAgent = {
      ...agent,
      metadata: { ...agent.metadata, taskType: 'internal' },
    };

    render(
      <MemoryRouter>
        <AgentCard agent={internalAgent} completed />
      </MemoryRouter>
    );

    expect(screen.queryByText('Was this helpful?')).not.toBeInTheDocument();
  });

  it('uses the archived scheduled type for a running agent ETA', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const runningAgent = {
      ...agent,
      status: 'running',
      startedAt: '2026-07-13T09:59:00.000Z',
      completedAt: null,
      metadata: {
        taskDescription: 'Fix the security configuration',
        taskType: 'internal',
        taskAnalysisType: 'security',
      },
    };
    const durations = {
      'self-improve:security': { avgDurationMs: 600000, p80DurationMs: 600000, completed: 5 },
      _overall: { avgDurationMs: 1000, p80DurationMs: 1000, completed: 20 },
    };

    render(
      <MemoryRouter>
        <AgentCard agent={runningAgent} durations={durations} />
      </MemoryRouter>
    );

    expect(screen.getByText('10% complete')).toBeInTheDocument();
  });

  it('returns the updated agent to its parent after a successful rating', async () => {
    const user = userEvent.setup();
    const updatedAgent = {
      ...agent,
      feedback: { rating: 'positive', submittedAt: '2026-07-13T12:00:00.000Z' },
    };
    const onFeedbackChange = vi.fn();
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: updatedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed onFeedbackChange={onFeedbackChange} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Mark as helpful' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'positive', comment: undefined },
      { silent: true }
    );
    await waitFor(() => expect(onFeedbackChange).toHaveBeenCalledWith(updatedAgent));
  });

  it('records a negative rating with the detail needed to improve future work', async () => {
    const user = userEvent.setup();
    const updatedAgent = {
      ...agent,
      feedback: {
        rating: 'negative',
        comment: 'The implementation did not include tests.',
        submittedAt: '2026-07-13T12:00:00.000Z'
      }
    };
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: updatedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Add feedback comment' }));
    await typeSettled(user, screen.getByPlaceholderText('What made this work well or poorly?'), updatedAgent.feedback.comment);
    await user.click(screen.getByRole('button', { name: 'Needs work' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'negative', comment: updatedAgent.feedback.comment },
      { silent: true }
    );
  });

  it('lets a quick rating receive a follow-up detail', async () => {
    const user = userEvent.setup();
    const ratedAgent = {
      ...agent,
      feedback: { rating: 'positive', submittedAt: '2026-07-13T12:00:00.000Z' }
    };
    const detailedAgent = {
      ...ratedAgent,
      feedback: { ...ratedAgent.feedback, comment: 'The focused test coverage was useful.' }
    };
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: detailedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={ratedAgent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Add feedback detail' }));
    await typeSettled(user, screen.getByPlaceholderText('What made this work well or poorly?'), detailedAgent.feedback.comment);
    await user.click(screen.getByRole('button', { name: 'Save detail' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'positive', comment: detailedAgent.feedback.comment },
      { silent: true }
    );
  });
});

describe('AgentCard agent ID', () => {
  it.each([
    ['active', { ...agent, status: 'running', completedAt: null }],
    ['historical', agent],
  ])('copies the full ID from the %s card', async (_label, cardAgent) => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AgentCard agent={cardAgent} completed={cardAgent.status === 'completed'} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Copy agent ID' }));

    expect(copyToClipboard).toHaveBeenCalledWith(cardAgent.id, 'Agent ID copied to clipboard');
  });
});

describe('AgentCard transcript truncation (#3498)', () => {
  it('says the transcript was clipped when the server returns a capped tail', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [{ line: 'last line', timestamp: agent.completedAt }],
      outputTruncated: true,
      outputTotalBytes: 12 * 1024 * 1024,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    expect(await screen.findByText(/Showing the last 1 line —/)).toBeInTheDocument();
    expect(screen.getByText(/12 MB/)).toBeInTheDocument();
  });

  it('still reports the clip when the tail window yielded no renderable lines', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [],
      outputTruncated: true,
      outputTotalBytes: 8 * 1024 * 1024,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    // "No output captured" would call a multi-MB log empty.
    expect(await screen.findByText(/no readable lines/)).toBeInTheDocument();
    expect(screen.queryByText('No output captured')).not.toBeInTheDocument();
  });

  it('stays quiet when the whole transcript fit under the cap', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [{ line: 'only line', timestamp: agent.completedAt }],
      outputTruncated: false,
      outputTotalBytes: 10,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    await waitFor(() => expect(api.getCosAgent).toHaveBeenCalledWith(agent.id));
    expect(screen.queryByText(/Showing the last/)).not.toBeInTheDocument();
  });
});

describe('AgentCard kill confirmation (#4034)', () => {
  it('requires confirmation before calling onKill', async () => {
    const user = userEvent.setup();
    const onKill = vi.fn().mockResolvedValue(true);
    const runningAgent = {
      ...agent,
      status: 'running',
      completedAt: null,
    };

    render(
      <MemoryRouter>
        <AgentCard agent={runningAgent} onKill={onKill} />
      </MemoryRouter>
    );

    // Clicking Kill should show confirmation prompt and NOT call onKill immediately
    await user.click(screen.getByRole('button', { name: 'Force kill agent (SIGKILL)' }));
    expect(onKill).not.toHaveBeenCalled();
    expect(screen.getByText('Kill?')).toBeInTheDocument();

    // Clicking Cancel disarms confirmation state
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onKill).not.toHaveBeenCalled();
    expect(screen.queryByText('Kill?')).not.toBeInTheDocument();

    // Re-arm and click Confirm
    await user.click(screen.getByRole('button', { name: 'Force kill agent (SIGKILL)' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onKill).toHaveBeenCalledWith(runningAgent.id);
  });
});


describe('AgentCard task description (#4170)', () => {
  // jsdom reports 0 for both scrollHeight and clientHeight, so nothing measures
  // as overflowing unless we force it.
  const forceOverflow = () =>
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);

  afterEach(() => vi.restoreAllMocks());

  it('caps a long description behind an accessible Show more toggle', async () => {
    const user = userEvent.setup();
    forceOverflow();

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    const box = document.getElementById(`agent-desc-${agent.id}`);
    expect(box).toHaveClass('overflow-hidden');

    // The bespoke implementation this replaced carried no aria wiring at all.
    const toggle = screen.getByRole('button', { name: /Show more/ });
    expect(toggle).toHaveAttribute('aria-controls', `agent-desc-${agent.id}`);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(box).not.toHaveClass('overflow-hidden');
    expect(screen.getByRole('button', { name: /Show less/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers no toggle for a description that fits', () => {
    // The replaced implementation gated on `text.length > 200`, so a 201-char
    // description that fit in the cap still rendered a no-op "Show more".
    render(
      <MemoryRouter>
        <AgentCard agent={{ ...agent, metadata: { ...agent.metadata, taskDescription: 'x'.repeat(300) } }} completed />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });
});

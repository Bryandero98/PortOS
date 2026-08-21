import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  getLocalLlmAssessmentSweep: vi.fn(),
  startLocalLlmAssessmentSweep: vi.fn(),
  cancelLocalLlmAssessmentSweep: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

import {
  getLocalLlmAssessmentSweep, startLocalLlmAssessmentSweep, cancelLocalLlmAssessmentSweep,
} from '../../services/api';
import socket from '../../services/socket';
import AssessmentSweepPanel from './AssessmentSweepPanel.jsx';

const idle = { status: 'idle', scope: null, total: 0, completed: 0, current: null, results: [], startedAt: null, finishedAt: null };

const counts = { unmeasured: 2, stale: 1, all: 4 };

const renderPanel = (props = {}) => render(
  <AssessmentSweepPanel counts={counts} contextTokens={[512, 4096, 16384]} onSweepFinished={vi.fn()} {...props} />
);

beforeEach(() => {
  vi.clearAllMocks();
  getLocalLlmAssessmentSweep.mockResolvedValue(idle);
});

describe('AssessmentSweepPanel', () => {
  // The AI Provider Usage Policy gate: a batch of provider calls has to be
  // preceded by a statement of exactly what will run.
  it('names the model and generation count before anything is queued', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure all models' }));
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
    expect(screen.getByText(/Measure every model\?/)).toBeInTheDocument();
    // 2 unmeasured models × 3 context lengths = 6 generations, spelled out.
    expect(screen.getByText(/short generations in total/)).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    expect(screen.getByText(/512, 4K, 16K tokens of context/)).toBeInTheDocument();
  });

  it('starts the scope the user picked', async () => {
    const user = userEvent.setup();
    startLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 4 });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure all models' }));
    await user.click(screen.getByLabelText(/Everything installed/));
    await user.click(screen.getByRole('button', { name: /start sweep/i }));

    await waitFor(() => expect(startLocalLlmAssessmentSweep).toHaveBeenCalledWith({ scope: 'all' }));
  });

  it('defaults to the first scope that has something to do', async () => {
    const user = userEvent.setup();
    startLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 1 });
    renderPanel({ counts: { unmeasured: 0, stale: 3, all: 3 } });

    await user.click(await screen.findByRole('button', { name: 'Measure all models' }));
    await user.click(screen.getByRole('button', { name: /start sweep/i }));
    await waitFor(() => expect(startLocalLlmAssessmentSweep).toHaveBeenCalledWith({ scope: 'stale' }));
  });

  it('does not queue anything when the ask is cancelled', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Measure all models' }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(startLocalLlmAssessmentSweep).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/Measure every model\?/)).not.toBeInTheDocument());
  });

  // The queue is server state. A sweep started in another tab, or before a
  // reload, has to show up here — otherwise the page offers to start a second one.
  it('picks up a sweep that was already running when it mounted', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle, status: 'running', total: 5, completed: 2,
      current: { backend: 'ollama', modelId: 'example-model:14b' },
    });
    renderPanel();

    expect(await screen.findByText(/2\/5 measured/)).toBeInTheDocument();
    expect(screen.getByText(/example-model:14b/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop sweep/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Measure all models' })).not.toBeInTheDocument();
  });

  it('says the run outlives the tab, because that is the whole point of it', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 3, completed: 0 });
    renderPanel();
    expect(await screen.findByText(/close this tab/i)).toBeInTheDocument();
  });

  it('stops the queue and lets the parent re-read what it measured', async () => {
    const user = userEvent.setup();
    const onSweepFinished = vi.fn();
    getLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 5, completed: 2 });
    cancelLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'cancelled', total: 5, completed: 2 });
    renderPanel({ onSweepFinished });

    await user.click(await screen.findByRole('button', { name: /stop sweep/i }));
    await waitFor(() => expect(cancelLocalLlmAssessmentSweep).toHaveBeenCalled());
    // Two measurements are real evidence even though the run was abandoned.
    await waitFor(() => expect(onSweepFinished).toHaveBeenCalled());
  });

  // Results are what you read the next morning — they must survive the queue
  // ending rather than disappearing with the progress bar.
  it('keeps the finished results on screen after the sweep ends', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'complete',
      total: 2,
      completed: 2,
      finishedAt: '2026-01-01T00:00:00.000Z',
      results: [
        { backend: 'ollama', modelId: 'fast-model', verdict: 'fits', error: null, meanTokensPerSecond: 61, finishedAt: '2026-01-01T00:00:00.000Z' },
        { backend: 'ollama', modelId: 'big-model', verdict: 'does-not-fit', error: null, meanTokensPerSecond: null, meanCharsPerSecond: null, finishedAt: '2026-01-01T00:01:00.000Z' },
      ],
    });
    renderPanel();

    expect(await screen.findByText(/Sweep results \(2\)/)).toBeInTheDocument();
    expect(screen.getByText('fast-model')).toBeInTheDocument();
    expect(screen.getByText(/fits — 61 tok\/s/)).toBeInTheDocument();
    expect(screen.getByText('does-not-fit')).toBeInTheDocument();
  });

  it('falls back to chars/s for a runtime that reported no token counts', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({
      ...idle,
      status: 'complete',
      total: 1,
      completed: 1,
      results: [{ backend: 'llama', modelId: 'quiet-model', verdict: 'fits', error: null, meanTokensPerSecond: null, meanCharsPerSecond: 240, finishedAt: '2026-01-01T00:00:00.000Z' }],
    });
    renderPanel();
    expect(await screen.findByText(/fits — 240 chars\/s/)).toBeInTheDocument();
  });

  it('subscribes to the shared progress event and filters out unrelated frames', async () => {
    getLocalLlmAssessmentSweep.mockResolvedValue({ ...idle, status: 'running', total: 2, completed: 0 });
    renderPanel();
    await screen.findByText(/0\/2 measured/);

    const handler = socket.on.mock.calls.find(([event]) => event === 'localLlm:progress')[1];
    // A model PULL streams on the same event, in the shape the install route
    // actually emits (`{ event, message }`, no scope) — it must not drive this line.
    await act(async () => handler({ event: 'progress', message: 'pulling manifest' }));
    expect(screen.queryByText('pulling manifest')).not.toBeInTheDocument();

    await act(async () => handler({ scope: 'assessment', message: 'example-model: sample 2/3 at 4,096 tokens…' }));
    expect(await screen.findByText(/sample 2\/3/)).toBeInTheDocument();
  });

  it('offers nothing to press when no runtime lists a model to measure', async () => {
    renderPanel({ counts: { unmeasured: 0, stale: 0, all: 0 } });
    expect(await screen.findByRole('button', { name: 'Measure all models' })).toBeDisabled();
  });

  it('is disabled while a single-model run already holds the provider', async () => {
    renderPanel({ disabled: true });
    expect(await screen.findByRole('button', { name: 'Measure all models' })).toBeDisabled();
  });
});

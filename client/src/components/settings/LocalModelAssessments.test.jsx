import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  getLocalLlmAssessments: vi.fn(),
  runLocalLlmAssessment: vi.fn(),
  deleteLocalLlmAssessment: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

// Per-sample run progress arrives on the shared `localLlm:progress` socket
// event; the tests below replay frames through the registered handler.
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

import { getLocalLlmAssessments, runLocalLlmAssessment, deleteLocalLlmAssessment } from '../../services/api';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import LocalModelAssessments from './LocalModelAssessments.jsx';

const report = (overrides = {}) => ({
  intent: 'balanced',
  intents: ['balanced', 'smartest', 'fastest', 'lightweight'],
  defaultContextTokens: [512, 4096, 16384],
  assessments: [],
  unassessed: [],
  listErrors: [],
  readError: null,
  ranked: [],
  excluded: [],
  runtimes: RUNTIMES,
  tuningComparison: [],
  uninstalled: [],
  ...overrides,
});

// The runtime roster is server-derived — label, reachability, and the knob
// catalog all ride on the report, so the panel has no hardcoded backend list to
// drift from.
const RUNTIMES = [
  { id: 'ollama', label: 'Ollama', managed: true, modelCount: 1, error: null, tuningSpecs: [
    { id: 'numCtx', label: 'Context size', type: 'number', applies: 'request', min: 512, max: 1048576, unit: 'tokens', hint: 'Sent with the request.' },
  ] },
  { id: 'llama', label: 'llama.cpp', managed: false, modelCount: 3, error: null, tuningSpecs: [
    { id: 'ubatchSize', label: 'Micro-batch size', type: 'number', applies: 'launch', min: 1, max: 8192, hint: 'Physical micro-batch.' },
    { id: 'flashAttn', label: 'Flash attention', type: 'boolean', applies: 'launch', hint: 'Fused attention kernel.' },
  ] },
  { id: 'mtplx', label: 'MTPLX', managed: false, modelCount: null, error: 'not reachable at http://127.0.0.1:8000/v1 (ECONNREFUSED)', tuningSpecs: [] },
];

const rankedEntry = (overrides = {}) => ({
  backend: 'ollama',
  modelId: 'example-model:7b',
  verdict: 'fits',
  score: 0.7,
  coverage: 1,
  scores: { capability: 0.5, speed: 0.6, fidelity: 0.9, memory: 0.8 },
  performance: {
    meanCharsPerSecond: 120,
    meanTtftMs: 250,
    maxWorkingContextTokens: 4096,
    peakCharsPerSecond: 140,
    contextDegradation: 0.85,
    samplesRun: 3,
    samplesOk: 3,
  },
  residentGb: 5,
  params: '7B',
  assessedAt: '2026-01-01T00:00:00.000Z',
  explanation: '120 chars/s measured, ran at up to 4,096 tokens of context.',
  ...overrides,
});

describe('LocalModelAssessments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLocalLlmAssessments.mockResolvedValue(report());
  });

  it('loads persisted results on mount without triggering any model run', async () => {
    render(<LocalModelAssessments />);
    await waitFor(() => expect(getLocalLlmAssessments).toHaveBeenCalled());
    // The AI Provider Usage Policy boundary: mounting the panel must never
    // reach a provider.
    expect(runLocalLlmAssessment).not.toHaveBeenCalled();
  });

  it('renders measured numbers for a ranked model', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [rankedEntry()] }));
    render(<LocalModelAssessments />);
    expect(await screen.findByText('example-model:7b')).toBeInTheDocument();
    expect(screen.getByText('120 chars/s')).toBeInTheDocument();
    expect(screen.getByText('4K tokens')).toBeInTheDocument();
    // Resident size is measured by /api/ps and must survive into the ranked
    // entry — rendering "not measured" here would hide a real measurement.
    expect(screen.getByText('5.0 GB')).toBeInTheDocument();
    expect(screen.getByText('Fits')).toBeInTheDocument();
  });

  it('says "not measured" rather than showing a zero for an unmeasured field', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry({
        residentGb: null,
        performance: { ...rankedEntry().performance, meanCharsPerSecond: null, meanTtftMs: null },
        scores: { capability: 0.5, speed: null, fidelity: null, memory: null },
      })],
    }));
    render(<LocalModelAssessments />);
    await screen.findByText('example-model:7b');
    expect(screen.getAllByText('not measured').length).toBeGreaterThanOrEqual(3);
    // An unmeasured axis renders as n/a, never as an empty bar that reads as 0.
    expect(screen.getAllByText('n/a')).toHaveLength(3);
  });

  it('requires explicit consent naming the model and run count before running', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits' });
    render(<LocalModelAssessments />);

    await user.click(await screen.findByRole('button', { name: /measure/i }));
    // Nothing has been sent yet — the click opens the ask, it does not run.
    expect(runLocalLlmAssessment).not.toHaveBeenCalled();
    expect(screen.getByText(/Measure this model\?/)).toBeInTheDocument();
    expect(screen.getByText(/3 times/)).toBeInTheDocument();
    expect(screen.getByText(/512, 4K, 16K tokens of context/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /run assessment/i }));
    await waitFor(() => expect(runLocalLlmAssessment).toHaveBeenCalledWith(
      { backend: 'ollama', modelId: 'example-model:7b', tuning: {} },
      expect.objectContaining({ silent: true, signal: expect.any(AbortSignal) }),
    ));
  });

  it('does not run when the consent modal is cancelled', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    render(<LocalModelAssessments />);

    await user.click(await screen.findByRole('button', { name: /measure/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(runLocalLlmAssessment).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/Measure this model\?/)).not.toBeInTheDocument());
  });

  it('presents unmeasured models as an open question, not as a poor choice', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'lmstudio', modelId: 'example-model:14b', params: '14B' }],
    }));
    render(<LocalModelAssessments />);
    expect(await screen.findByText(/Not yet measured \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/not a mark against them/)).toBeInTheDocument();
  });

  it('refetches for the selected intent', async () => {
    const user = userEvent.setup();
    render(<LocalModelAssessments />);
    await waitFor(() => expect(getLocalLlmAssessments).toHaveBeenCalledWith('balanced', { silent: true }));
    await user.selectOptions(screen.getByLabelText('Rank for'), 'fastest');
    await waitFor(() => expect(getLocalLlmAssessments).toHaveBeenCalledWith('fastest', { silent: true }));
  });

  it('drops a discarded measurement from local state and returns it to the unmeasured list', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry()],
      assessments: [{ backend: 'ollama', modelId: 'example-model:7b' }],
    }));
    deleteLocalLlmAssessment.mockResolvedValue({ success: true });
    render(<LocalModelAssessments />);

    await user.click(await screen.findByRole('button', { name: /discard the measurement/i }));
    await waitFor(() => expect(screen.getByText(/Not yet measured \(1\)/)).toBeInTheDocument());
    expect(deleteLocalLlmAssessment).toHaveBeenCalledWith('ollama', 'example-model:7b', '', { silent: true });
  });

  it('aborts an in-flight run when the user stops it, without toasting a failure', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    // A run occupies the local provider for minutes; the modal's only exit must
    // stay live and actually abort, not merely close over a job still running.
    let capturedSignal;
    runLocalLlmAssessment.mockImplementation((_payload, options) => {
      capturedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('Server unreachable')));
      });
    });
    render(<LocalModelAssessments />);

    await user.click(await screen.findByRole('button', { name: /measure/i }));
    await user.click(screen.getByRole('button', { name: /run assessment/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /stop/i }));
    await waitFor(() => expect(capturedSignal.aborted).toBe(true));
    // The abort is what the user asked for — it must not surface as an error.
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('aborts a run in flight when the panel unmounts', async () => {
    const user = userEvent.setup();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
    }));
    let capturedSignal;
    runLocalLlmAssessment.mockImplementation((_payload, options) => {
      capturedSignal = options.signal;
      return new Promise(() => {});
    });
    const { unmount } = render(<LocalModelAssessments />);

    await user.click(await screen.findByRole('button', { name: /measure/i }));
    await user.click(screen.getByRole('button', { name: /run assessment/i }));
    await waitFor(() => expect(capturedSignal).toBeDefined());

    unmount();
    expect(capturedSignal.aborted).toBe(true);
  });

  it('explains a model that ran but was excluded from the ranking', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      excluded: [{ backend: 'ollama', modelId: 'example-model:70b', verdict: 'does-not-fit', reason: 'out of memory' }],
    }));
    render(<LocalModelAssessments />);
    expect(await screen.findByText('example-model:70b')).toBeInTheDocument();
    expect(screen.getByText('Does not fit')).toBeInTheDocument();
    expect(screen.getByText('out of memory')).toBeInTheDocument();
  });

  it('warns when a backend model list could not be read instead of implying it is empty', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ listErrors: ['lmstudio'] }));
    render(<LocalModelAssessments />);
    expect(await screen.findByText(/Could not list installed models for LM Studio/)).toBeInTheDocument();
  });

  describe('stale measurements', () => {
    it('flags a reading taken on a different machine state and says what changed', async () => {
      getLocalLlmAssessments.mockResolvedValue(report({
        ranked: [rankedEntry({
          staleness: {
            comparable: true,
            stale: true,
            changes: [{ field: 'totalMemoryGb', label: 'installed memory', from: 32, to: 64 }],
            description: 'Measured on a different machine state — installed memory 32 → 64.',
          },
        })],
      }));
      render(<LocalModelAssessments />);

      expect(await screen.findByText('stale')).toBeInTheDocument();
      expect(screen.getByText(/installed memory 32 → 64/)).toBeInTheDocument();
      expect(screen.getByText(/Measure again to refresh it/)).toBeInTheDocument();
    });

    it('says nothing when the reading still matches this machine', async () => {
      getLocalLlmAssessments.mockResolvedValue(report({
        ranked: [rankedEntry({ staleness: { comparable: true, stale: false, changes: [], description: null } })],
      }));
      render(<LocalModelAssessments />);

      await screen.findByText('example-model:7b');
      expect(screen.queryByText('stale')).not.toBeInTheDocument();
    });

    it('does not claim freshness for a record nothing could be compared against', async () => {
      // `comparable: false` is UNKNOWN, not current — it must not render a
      // stale warning either way.
      getLocalLlmAssessments.mockResolvedValue(report({
        ranked: [rankedEntry({ staleness: { comparable: false, stale: false, changes: [], description: null } })],
      }));
      render(<LocalModelAssessments />);

      await screen.findByText('example-model:7b');
      expect(screen.queryByText('stale')).not.toBeInTheDocument();
    });
  });

  describe('run progress', () => {
    const emitProgress = (frame) => {
      // Replay whatever handler the component registered on the shared event.
      for (const [event, handler] of socket.on.mock.calls) {
        if (event === 'localLlm:progress') act(() => handler(frame));
      }
    };

    const startRun = async () => {
      const user = userEvent.setup();
      getLocalLlmAssessments.mockResolvedValue(report({
        unassessed: [{ backend: 'ollama', modelId: 'example-model:7b', params: '7B' }],
      }));
      // Never resolves during the test — the run stays in flight so progress renders.
      runLocalLlmAssessment.mockImplementation(() => new Promise(() => {}));
      render(<LocalModelAssessments />);
      await user.click(await screen.findByRole('button', { name: /measure/i }));
      await user.click(await screen.findByRole('button', { name: /run assessment/i }));
      return user;
    };

    it('renders per-sample progress from the shared localLlm:progress event', async () => {
      await startRun();
      emitProgress({
        scope: 'assessment', backend: 'ollama', modelId: 'example-model:7b',
        event: 'start', sampleIndex: 1, sampleCount: 3, message: 'example-model:7b: sample 2/3 at 4,096 tokens of context…',
      });
      expect(await screen.findByText(/sample 2\/3 at 4,096 tokens/)).toBeInTheDocument();
    });

    it('ignores frames from an unrelated model pull on the same channel', async () => {
      await startRun();
      emitProgress({ event: 'start', message: 'other-model:70b: pulling 42%' });
      emitProgress({
        scope: 'assessment', backend: 'ollama', modelId: 'some-other-model:3b',
        event: 'start', sampleIndex: 1, sampleCount: 3, message: 'some-other-model:3b: sample 2/3',
      });
      await waitFor(() => expect(screen.queryByText(/pulling 42%/)).not.toBeInTheDocument());
      expect(screen.queryByText(/some-other-model/)).not.toBeInTheDocument();
      // …and the panel is still live: its OWN frame renders right after.
      emitProgress({
        scope: 'assessment', backend: 'ollama', modelId: 'example-model:7b',
        event: 'start', sampleIndex: 0, sampleCount: 3, message: 'example-model:7b: sample 1/3',
      });
      expect(await screen.findByText(/sample 1\/3/)).toBeInTheDocument();
    });

    it('unsubscribes on unmount so a late frame cannot update a dead panel', async () => {
      getLocalLlmAssessments.mockResolvedValue(report());
      const { unmount } = render(<LocalModelAssessments />);
      await screen.findByText(/Nothing measured yet/);
      unmount();
      expect(socket.off).toHaveBeenCalledWith('localLlm:progress', expect.any(Function));
    });
  });
});

// ---------------------------------------------------------------------------
// Runtimes and launch tuning
// ---------------------------------------------------------------------------

describe('LocalModelAssessments — runtimes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLocalLlmAssessments.mockResolvedValue(report());
  });

  it('lists every assessable runtime from the report, not a hardcoded set', async () => {
    render(<LocalModelAssessments />);
    for (const label of ['Ollama', 'llama.cpp', 'MTPLX']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  // A stopped daemon must not read as "0 models" — that says "nothing
  // installed" when the fix is to start it.
  it('shows an unreachable runtime as unreachable, never as zero models', async () => {
    render(<LocalModelAssessments />);
    expect(await screen.findByText('unreachable')).toBeInTheDocument();
    expect(screen.getByText('1 model')).toBeInTheDocument();
    expect(screen.getByText('3 models')).toBeInTheDocument();
  });

  it('names a runtime by its server-supplied label on a ranked row', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      ranked: [rankedEntry({ backend: 'llama', modelId: 'dflash' })],
    }));
    render(<LocalModelAssessments />);
    expect(await screen.findByText('dflash')).toBeInTheDocument();
    // Once in the roster, once on the row.
    expect(screen.getAllByText('llama.cpp').length).toBeGreaterThan(1);
  });
});

describe('LocalModelAssessments — tuning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLocalLlmAssessments.mockResolvedValue(report({
      unassessed: [{ backend: 'llama', modelId: 'dflash', params: null }],
    }));
  });

  it('sends the knobs the user set with the run', async () => {
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits', tuningApplied: true });
    const user = userEvent.setup();
    render(<LocalModelAssessments />);
    await user.click(await screen.findByRole('button', { name: /Measure/ }));
    await user.click(await screen.findByRole('button', { name: /Tuning/ }));
    await user.type(screen.getByLabelText('Micro-batch size'), '512');
    await user.click(screen.getByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(runLocalLlmAssessment).toHaveBeenCalledWith(
      { backend: 'llama', modelId: 'dflash', tuning: { ubatchSize: 512 } },
      expect.objectContaining({ silent: true }),
    ));
  });

  // An empty field means "leave the daemon on its own default". Sending 0 would
  // pin a value the user never chose.
  it('omits an untouched knob rather than sending a zero', async () => {
    runLocalLlmAssessment.mockResolvedValue({ verdict: 'fits', tuningApplied: true });
    const user = userEvent.setup();
    render(<LocalModelAssessments />);
    await user.click(await screen.findByRole('button', { name: /Measure/ }));
    await user.click(await screen.findByRole('button', { name: /Tuning/ }));
    await user.click(screen.getByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(runLocalLlmAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ tuning: {} }),
      expect.anything(),
    ));
  });

  it('says what PortOS can and cannot set for each knob', async () => {
    const user = userEvent.setup();
    render(<LocalModelAssessments />);
    await user.click(await screen.findByRole('button', { name: /Measure/ }));
    await user.click(await screen.findByRole('button', { name: /Tuning/ }));
    expect(screen.getAllByText(/puts this on the launch line/).length).toBe(2);
  });

  it('warns instead of celebrating when the tuning never reached the daemon', async () => {
    runLocalLlmAssessment.mockResolvedValue({
      verdict: 'fits', tuningApplied: false, tuningNotApplied: 'llama-server is not running',
    });
    const user = userEvent.setup();
    render(<LocalModelAssessments />);
    await user.click(await screen.findByRole('button', { name: /Measure/ }));
    await user.click(screen.getByRole('button', { name: 'Run assessment' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/tuning not applied/)));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('LocalModelAssessments — tuning comparison', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows each tuning against the winner once a model has two', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({
      tuningComparison: [{
        backend: 'llama',
        modelId: 'dflash',
        best: { tuning: { ubatchSize: 512 }, label: 'Micro-batch size 512', charsPerSecond: 120 },
        variants: [
          { tuning: { ubatchSize: 512 }, label: 'Micro-batch size 512', charsPerSecond: 120, deltaPercent: 100, maxWorkingContextTokens: 16384, assessedAt: null },
          { tuning: {}, label: 'Backend defaults', charsPerSecond: 90, deltaPercent: 75, maxWorkingContextTokens: 16384, assessedAt: null },
        ],
      }],
    }));
    render(<LocalModelAssessments />);
    expect(await screen.findByText('Tuning comparison')).toBeInTheDocument();
    expect(screen.getByText('Micro-batch size 512')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('renders nothing when no model has been measured under two tunings', async () => {
    getLocalLlmAssessments.mockResolvedValue(report());
    render(<LocalModelAssessments />);
    await screen.findByText('Ollama');
    expect(screen.queryByText('Tuning comparison')).toBeNull();
  });

  it('labels an untuned reading as backend defaults, not as a blank', async () => {
    getLocalLlmAssessments.mockResolvedValue(report({ ranked: [rankedEntry()] }));
    render(<LocalModelAssessments />);
    expect(await screen.findByText('backend defaults')).toBeInTheDocument();
  });
});

/**
 * Models → Status hosts BOTH halves of "what models does this machine have":
 * residency (loaded right now) and the downloaded-model inventory that used to
 * live at Dev Tools' `/system-resources/models` (#4728).
 *
 * The fold is only real if the inventory actually renders here — and only
 * tolerable if it does NOT scan on mount: the scan walks the Hugging Face cache,
 * `data/loras/`, Ollama and LM Studio, which is slow and wasted on a user who
 * came to unload a model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const runSystemResourceReport = vi.fn();
vi.mock('../../services/api', () => ({
  runSystemResourceReport: (...a) => runSystemResourceReport(...a),
  purgeDataCategory: vi.fn(),
  deleteCachedModel: vi.fn(),
  deleteLora: vi.fn(),
  deleteLocalLlmModel: vi.fn(),
}));

vi.mock('../settings/MemoryManagement.jsx', () => ({ default: () => <div>residency panel</div> }));

import ModelStatusTab from './ModelStatusTab';

const REPORT = {
  generatedAt: '2026-08-21T00:00:00.000Z',
  cleanupCandidates: [],
  sourceErrors: [],
  models: {
    downloaded: [{
      id: 'huggingface:example-model',
      name: 'example-model',
      backend: 'huggingface',
      sizeBytes: 2048,
      loaded: false,
    }],
    loaded: [],
    totals: { all: 2048 },
  },
};

const renderTab = () => render(<MemoryRouter><ModelStatusTab /></MemoryRouter>);

describe('ModelStatusTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows residency without scanning disk on mount', () => {
    renderTab();
    expect(screen.getByText('residency panel')).toBeInTheDocument();
    expect(runSystemResourceReport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /run model inventory/i })).toBeInTheDocument();
  });

  it('renders the downloaded-model inventory once the user asks for it', async () => {
    runSystemResourceReport.mockResolvedValue(REPORT);
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /run model inventory/i }));
    await waitFor(() => expect(runSystemResourceReport).toHaveBeenCalledWith({ silent: true }));
    expect(await screen.findByText('example-model')).toBeInTheDocument();
    expect(screen.getByText(/downloaded model inventory/i)).toBeInTheDocument();
  });
});

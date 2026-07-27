import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  getProviderUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBackfillStatus: vi.fn(),
  startUsageBackfill: vi.fn()
}));

vi.mock('../services/api', () => api);

const UsagePage = (await import('./UsagePage')).default;

const usage = {
  totalSessions: 1,
  totalMessages: 1,
  totalTokens: { input: 10, output: 5 },
  last7Days: [],
  hourlyActivity: Array(24).fill(0),
  topProviders: [],
  topModels: [],
  report: {
    pricingAsOf: '2026-07-01',
    providers: [],
    totals: { estimatedCost: 0, source: 'estimate' }
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getProviderUsage.mockResolvedValue({ providers: [] });
  api.getUsage.mockResolvedValue(usage);
  api.getUsageBackfillStatus.mockResolvedValue({ status: 'idle' });
  api.startUsageBackfill.mockResolvedValue({ status: 'complete', corrected: 2 });
});

describe('UsagePage historical reconciliation', () => {
  it('starts only from the explicit user action and reports completion', async () => {
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    const button = await screen.findByRole('button', { name: 'Reconcile now' });
    expect(api.startUsageBackfill).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(api.startUsageBackfill).toHaveBeenCalledWith({ silent: true }));
    expect(await screen.findByText('Corrected 2 runs.')).toBeInTheDocument();
  });
});

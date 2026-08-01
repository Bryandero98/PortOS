import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = {
  getStackerNewsAccounts: vi.fn(),
  getStackerNewsTerritories: vi.fn(),
  getStackerNewsItems: vi.fn(),
  getStackerNewsActions: vi.fn(),
  updateStackerNewsAccount: vi.fn(),
  createStackerNewsAccount: vi.fn(),
  createStackerNewsTerritory: vi.fn(),
  verifyStackerNewsAccount: vi.fn(),
  getStackerNewsBrowserIdentity: vi.fn(),
  syncStackerNewsAccount: vi.fn(),
  analyzeStackerNewsItem: vi.fn(),
  createStackerNewsAction: vi.fn(),
  reviewStackerNewsAction: vi.fn(),
  executeStackerNewsAction: vi.fn(),
};
vi.mock('../services/api', () => api);
vi.mock('../hooks/useLocalModels', () => ({ default: () => ({ ollama: ['example-text', 'example-vision'], loading: false }) }));
const { default: StackerNews } = await import('./StackerNews.jsx');

const accounts = [
  { id: 'a1', label: 'Art steward', username: 'art_steward', enabled: true, monitoringEnabled: true, monitoringIntervalMinutes: 15, analysisEnabled: true, textModel: 'example-text', visionModel: '', rules: { guidance: 'Curate visual work' }, apiKeyConfigured: true },
  { id: 'a2', label: 'Personal', username: 'personal_stacker', enabled: true, monitoringEnabled: false, monitoringIntervalMinutes: 60, analysisEnabled: false, textModel: '', visionModel: '', rules: { guidance: 'Personal rules' }, apiKeyConfigured: false },
];

function renderPage(path) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/stacker-news" element={<StackerNews />} /><Route path="/stacker-news/:accountId/:tab" element={<StackerNews />} /></Routes></MemoryRouter>);
}

describe('StackerNews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getStackerNewsAccounts.mockResolvedValue({ accounts });
    api.getStackerNewsTerritories.mockResolvedValue({ territories: [] });
    api.getStackerNewsItems.mockResolvedValue({ items: [] });
    api.getStackerNewsActions.mockResolvedValue({ actions: [] });
  });

  it('deep-links to one account and shows its independent schedule and rules', async () => {
    renderPage('/stacker-news/a1/accounts');
    expect(await screen.findByText('@art_steward · every 15m')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Curate visual work')).toBeInTheDocument();
    expect(screen.getByDisplayValue('15')).toBeInTheDocument();
    expect(screen.getByText('@personal_stacker · monitoring off')).toBeInTheDocument();
  });

  it('opens account setup on the bare route so a first-time install is usable', async () => {
    renderPage('/stacker-news');
    expect(await screen.findByRole('heading', { name: 'Add account' })).toBeInTheDocument();
  });

  it('saves only the selected account configuration', async () => {
    const user = userEvent.setup();
    api.updateStackerNewsAccount.mockResolvedValue({ ...accounts[0], monitoringIntervalMinutes: 20 });
    renderPage('/stacker-news/a1/accounts');
    await screen.findByDisplayValue('Curate visual work');
    const interval = screen.getByLabelText('Monitoring interval (minutes)', { selector: '#edit-account-interval' });
    await user.clear(interval);
    await user.type(interval, '20');
    await user.click(screen.getByRole('button', { name: 'Save account' }));
    await waitFor(() => expect(api.updateStackerNewsAccount).toHaveBeenCalledWith('a1', expect.objectContaining({ monitoringIntervalMinutes: 20 }), { silent: true }));
  });

  it('renders a recovery path for a stale account URL', async () => {
    renderPage('/stacker-news/missing/review');
    expect(await screen.findByText(/account was not found/i)).toBeInTheDocument();
  });
});

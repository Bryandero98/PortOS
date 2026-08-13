import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getApps: vi.fn(),
  getRuns: vi.fn(),
  getProviderStatuses: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../services/socket', () => ({
  default: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));
vi.mock('../hooks/useLocalModels', () => ({
  default: () => ({ ctxById: {} }),
}));
vi.mock('../components/settings/SettingsTabsHeader', () => ({
  default: () => <div data-testid="settings-tabs-header" />,
}));
vi.mock('../components/providers/CodeReviewDefaultsPanel', () => ({
  default: () => <div data-testid="code-review-defaults-panel" />,
}));

import AIProviders from './AIProviders';

const renderPage = () => render(
  <MemoryRouter>
    <AIProviders />
  </MemoryRouter>
);

describe('AIProviders page load error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getRuns.mockResolvedValue({ runs: [] });
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
  });

  it('renders provider list when api.getProviders succeeds with data', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'p1', name: 'OpenAI', type: 'api', enabled: true, endpoint: 'https://api.openai.com', models: ['gpt-4'] }
      ],
      activeProvider: 'p1',
    });

    renderPage();

    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
  });

  it('renders EmptyState when api.getProviders succeeds with 0 items', async () => {
    api.getProviders.mockResolvedValue({
      providers: [],
      activeProvider: null,
    });

    renderPage();

    expect(await screen.findByText('No providers configured')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
  });

  it('renders Banner with Retry button when api.getProviders rejects and does not show EmptyState', async () => {
    api.getProviders.mockRejectedValue(new Error('Network error'));

    renderPage();

    expect(await screen.findByText('Failed to load AI providers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
  });

  it('re-fetches when Retry button is clicked and displays providers upon success', async () => {
    api.getProviders
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        providers: [
          { id: 'p1', name: 'Claude', type: 'api', enabled: true, endpoint: 'https://api.anthropic.com', models: ['claude-3'] }
        ],
        activeProvider: 'p1',
      });

    renderPage();

    const retryBtn = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);

    expect(await screen.findByText('Claude')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
    expect(api.getProviders).toHaveBeenCalledTimes(2);
  });
});

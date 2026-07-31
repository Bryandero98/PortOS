import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../services/api', () => ({
  getBrainLink: vi.fn(),
  getBrainScanReport: vi.fn(),
}));

vi.mock('../components/cos/MarkdownOutput', () => ({
  default: ({ content }) => <div data-testid="markdown">{content}</div>,
}));

import * as api from '../services/api';
import BrainScanReport from './BrainScanReport';

const renderPage = () => render(
  <MemoryRouter initialEntries={['/brain/links/abc/scan-report']}>
    <Routes>
      <Route path="/brain/links/:id/scan-report" element={<BrainScanReport />} />
    </Routes>
  </MemoryRouter>
);

// `/brain*` is in Layout's isFullWidth list, so <main> is `overflow-hidden` and
// this page must supply its own scroll container — otherwise a long report is
// clipped with no way to reach the rest of it.
const expectOwnScrollContainer = (container) => {
  const scroller = container.querySelector('.overflow-y-auto');
  expect(scroller).not.toBeNull();
  expect(scroller.className).toContain('h-full');
};

describe('BrainScanReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrolls its own content in the loaded state', async () => {
    api.getBrainLink.mockResolvedValue({ title: 'Example Link', url: 'https://example.com', malwareScan: { verdict: 'CLEAN' } });
    api.getBrainScanReport.mockResolvedValue('# Report\n\nlong body');

    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('Example Link')).toBeInTheDocument());

    expectOwnScrollContainer(container);
    expect(screen.getByTestId('markdown')).toHaveTextContent('long body');
  });

  it('scrolls its own content in the loading state', () => {
    api.getBrainLink.mockReturnValue(new Promise(() => {}));
    api.getBrainScanReport.mockReturnValue(new Promise(() => {}));

    const { container } = renderPage();
    expectOwnScrollContainer(container);
  });

  it('scrolls its own content in the unavailable state', async () => {
    api.getBrainLink.mockRejectedValue(new Error('nope'));
    api.getBrainScanReport.mockRejectedValue(new Error('nope'));

    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('This scan report is unavailable.')).toBeInTheDocument());
    expectOwnScrollContainer(container);
  });
});

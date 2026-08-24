import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  getInstanceFeatures: vi.fn(),
  getPostStats: vi.fn(),
  getPostConfig: vi.fn(),
  getPostRecommendations: vi.fn(),
}));

vi.mock('../services/api', () => mock);

import DailyPostWidget from './DailyPostWidget';

describe('DailyPostWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getInstanceFeatures.mockResolvedValue({
      features: [{ id: 'post', enabled: false }],
    });
  });

  it('does not collect or render POST metrics when the feature is disabled', async () => {
    const { container } = render(<DailyPostWidget />);

    await waitFor(() => expect(mock.getInstanceFeatures).toHaveBeenCalledWith({ silent: true }));
    expect(mock.getPostStats).not.toHaveBeenCalled();
    expect(mock.getPostConfig).not.toHaveBeenCalled();
    expect(mock.getPostRecommendations).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});

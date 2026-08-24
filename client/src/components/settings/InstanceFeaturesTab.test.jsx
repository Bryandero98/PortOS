import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  getInstanceFeatures: vi.fn(),
  updateInstanceFeature: vi.fn(),
}));

vi.mock('../../services/api', () => mock);

import InstanceFeaturesTab from './InstanceFeaturesTab';

const POST_FEATURE = {
  id: 'post',
  label: 'POST',
  description: 'Daily cognitive practice, progress metrics, and reminder prompts.',
  enabled: true,
};

describe('InstanceFeaturesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.getInstanceFeatures.mockResolvedValue({ features: [POST_FEATURE] });
    mock.updateInstanceFeature.mockResolvedValue({ features: [{ ...POST_FEATURE, enabled: false }] });
  });

  it('shows the instance-local feature switch', async () => {
    render(<InstanceFeaturesTab />);

    const toggle = await screen.findByRole('switch', { name: 'Disable POST on this instance' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Active on this instance')).toBeInTheDocument();
  });

  it('persists a toggle and reflects the saved state', async () => {
    render(<InstanceFeaturesTab />);
    const toggle = await screen.findByRole('switch', { name: 'Disable POST on this instance' });

    fireEvent.click(toggle);

    await waitFor(() => expect(mock.updateInstanceFeature).toHaveBeenCalledWith('post', false, { silent: true }));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Not used on this instance')).toBeInTheDocument();
  });
});

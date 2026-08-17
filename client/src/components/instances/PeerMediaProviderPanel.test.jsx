import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  probePeer: vi.fn(),
  updatePeer: vi.fn(),
}));

import { probePeer, updatePeer } from '../../services/api';
import PeerMediaProviderPanel from './PeerMediaProviderPanel';

const basePeer = {
  id: 'peer-example',
  name: 'Example Provider',
  enabled: true,
  status: 'online',
};

const readyStatus = {
  state: 'ready',
  reason: null,
  checkedAt: '2026-08-17T12:00:00.000Z',
  freshUntil: '2026-08-17T12:01:00.000Z',
  snapshot: {
    queue: { running: 1, queued: 2, totalActive: 3, maxQueuedJobs: 4, accepting: true },
    capabilities: [{
      kind: 'audio',
      engine: 'minimax-music3',
      engineName: 'MiniMax Music 3',
      modelId: 'minimax-music3',
      modelName: 'MiniMax Music 3',
      ready: true,
      unavailableReason: null,
    }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  updatePeer.mockResolvedValue({ id: basePeer.id });
  probePeer.mockResolvedValue({ id: basePeer.id });
});

describe('PeerMediaProviderPanel', () => {
  it('opts in explicitly and probes before refreshing the card', async () => {
    const onRefresh = vi.fn();
    render(<PeerMediaProviderPanel peer={basePeer} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole('button', { name: /Remote media provider/i }));
    fireEvent.click(screen.getByLabelText(/Use this peer for remote audio/i));

    await waitFor(() => expect(updatePeer).toHaveBeenCalledWith('peer-example', {
      mediaProvider: { enabled: true, audioModels: [] },
    }));
    await waitFor(() => expect(probePeer).toHaveBeenCalledWith('peer-example'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('shows queue capacity and persists an allowlisted model without dropping future config fields', async () => {
    const onRefresh = vi.fn();
    const peer = {
      ...basePeer,
      mediaProvider: { enabled: true, audioModels: [], futureField: 'keep' },
      mediaProviderStatus: readyStatus,
    };
    render(<PeerMediaProviderPanel peer={peer} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole('button', { name: /Remote media provider/i }));
    expect(screen.getByText(/1 running · 2 queued · 3\/4 shared slots active/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Allow MiniMax Music 3'));

    await waitFor(() => expect(updatePeer).toHaveBeenCalledWith('peer-example', {
      mediaProvider: {
        enabled: true,
        futureField: 'keep',
        audioModels: [{ engine: 'minimax-music3', modelId: 'minimax-music3' }],
      },
    }));
    expect(probePeer).not.toHaveBeenCalled();
  });

  it('explains that stale capacity blocks new work', () => {
    render(<PeerMediaProviderPanel peer={{
      ...basePeer,
      mediaProvider: { enabled: true, audioModels: [] },
      mediaProviderStatus: { ...readyStatus, state: 'stale', reason: 'stale' },
    }} onRefresh={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Remote media provider/i }));
    expect(screen.getByText(/capacity snapshot expired/i)).toBeInTheDocument();
  });
});

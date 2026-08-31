import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getAppRepositorySources: vi.fn(),
  syncAppRepositoryFork: vi.fn(),
  pullAndUpdateApp: vi.fn(),
}));

import * as api from '../../../services/api';
import EidoverseSourcePanel from './EidoverseSourcePanel';

const source = ({
  id,
  label,
  branch,
  head,
  origin,
  localVsOrigin = { ahead: 0, behind: 0, state: 'current' },
  forkVsUpstream = null,
}) => ({
  id,
  label,
  present: true,
  branch,
  head,
  shortHead: head.slice(0, 7),
  clean: true,
  origin: {
    hasOrigin: true,
    isGithub: true,
    head,
    shortHead: head.slice(0, 7),
    ...origin,
  },
  upstream: {
    fullName: `anima-research/${id === 'worlds' ? 'eidoverse-worlds' : 'eidoverse-video'}`,
    branch,
  },
  localVsOrigin,
  forkVsUpstream,
  remoteFresh: true,
  remoteError: null,
});

const canonicalStatus = () => ({
  kind: 'eidoverse',
  updateAvailable: true,
  updatePullsBoth: true,
  updateRestartsApp: true,
  sources: [
    source({
      id: 'worlds',
      label: 'Eidoverse Worlds',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'anima-research/eidoverse-worlds',
        isUpstream: true,
        isFork: false,
      },
      localVsOrigin: { ahead: 0, behind: 1, state: 'behind' },
    }),
    source({
      id: 'video',
      label: 'Eidoverse Video',
      branch: 'prod-serving',
      head: '2'.repeat(40),
      origin: {
        fullName: 'anima-research/eidoverse-video',
        isUpstream: true,
        isFork: false,
      },
    }),
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getAppRepositorySources.mockResolvedValue(canonicalStatus());
  api.syncAppRepositoryFork.mockResolvedValue({ synced: true, alreadyUpToDate: false });
  api.pullAndUpdateApp.mockResolvedValue({ success: true });
});

afterEach(() => cleanup());

describe('Eidoverse source stack', () => {
  it('explains and versions both independent checkouts', async () => {
    render(<EidoverseSourcePanel appId="app-eidoverse" />);

    expect(await screen.findByText('Eidoverse source stack')).toBeInTheDocument();
    expect(screen.getByText('Sidecar runtime · independent checkout · not a submodule')).toBeInTheDocument();
    expect(screen.getByTestId('eidoverse-source-worlds')).toHaveTextContent('main @ 1111111');
    expect(screen.getByTestId('eidoverse-source-worlds')).toHaveTextContent('Checkout 1 behind');
    expect(screen.getByTestId('eidoverse-source-video')).toHaveTextContent('prod-serving @ 2222222');
    expect(screen.getByTestId('eidoverse-source-video')).toHaveTextContent('Current');
    expect(screen.getByRole('button', { name: 'Update both' })).toBeInTheDocument();
  });

  it('shows local, fork, and upstream as separate version hops and can sync only the fork', async () => {
    const status = canonicalStatus();
    status.sources[0] = source({
      id: 'worlds',
      label: 'Eidoverse Worlds',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/eidoverse-worlds',
        isUpstream: false,
        isFork: true,
      },
      forkVsUpstream: { available: true, ahead: 0, behind: 2, state: 'behind', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    render(<EidoverseSourcePanel appId="app-eidoverse" />);

    const worlds = await screen.findByTestId('eidoverse-source-worlds');
    expect(worlds).toHaveTextContent('example-owner/eidoverse-worlds (fork)');
    expect(worlds).toHaveTextContent('anima-research/eidoverse-worlds (upstream)');
    expect(screen.getByRole('button', { name: 'Sync fork & update both' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync fork only' }));
    await waitFor(() => expect(api.syncAppRepositoryFork).toHaveBeenCalledWith('app-eidoverse', { silent: true }));
    expect(api.pullAndUpdateApp).not.toHaveBeenCalled();
  });

  it('confirms that a combined update syncs the fork, pulls both repos, and restarts only Eidoverse', async () => {
    const status = canonicalStatus();
    status.sources[0] = source({
      id: 'worlds',
      label: 'Eidoverse Worlds',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/eidoverse-worlds',
        isUpstream: false,
        isFork: true,
      },
      forkVsUpstream: { available: true, ahead: 0, behind: 2, state: 'behind', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    const onUpdated = vi.fn();
    render(<EidoverseSourcePanel appId="app-eidoverse" onUpdated={onUpdated} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sync fork & update both' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Pull the independent Eidoverse Video sidecar checkout');
    expect(dialog).toHaveTextContent('Restart Eidoverse Worlds only; PortOS and its CoS agents keep running');

    fireEvent.click(screen.getByRole('button', { name: 'Sync and update both' }));
    await waitFor(() => expect(api.pullAndUpdateApp).toHaveBeenCalledWith('app-eidoverse', { silent: true }));
    expect(api.syncAppRepositoryFork).toHaveBeenCalledWith('app-eidoverse', { silent: true });
    expect(api.syncAppRepositoryFork.mock.invocationCallOrder[0])
      .toBeLessThan(api.pullAndUpdateApp.mock.invocationCallOrder[0]);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
  });

  it('refuses automatic fork sync after divergence but still permits updating from the fork as-is', async () => {
    const status = canonicalStatus();
    status.sources[0] = source({
      id: 'worlds',
      label: 'Eidoverse Worlds',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/eidoverse-worlds',
        isUpstream: false,
        isFork: true,
      },
      forkVsUpstream: { available: true, ahead: 1, behind: 2, state: 'diverged', error: null },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    render(<EidoverseSourcePanel appId="app-eidoverse" />);

    expect(await screen.findByRole('button', { name: 'Fork needs reconciliation' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update both from fork' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Update both' }));

    await waitFor(() => expect(api.pullAndUpdateApp).toHaveBeenCalledOnce());
    expect(api.syncAppRepositoryFork).not.toHaveBeenCalled();
  });

  it('never reports current when the fork-to-upstream comparison failed', async () => {
    const status = canonicalStatus();
    status.updateAvailable = false;
    status.sources[0] = source({
      id: 'worlds',
      label: 'Eidoverse Worlds',
      branch: 'main',
      head: '1'.repeat(40),
      origin: {
        fullName: 'example-owner/eidoverse-worlds',
        isUpstream: false,
        isFork: true,
      },
      forkVsUpstream: {
        available: false,
        ahead: null,
        behind: null,
        state: 'unknown',
        error: 'Could not compare the fork with canonical upstream',
      },
    });
    api.getAppRepositorySources.mockResolvedValue(status);
    render(<EidoverseSourcePanel appId="app-eidoverse" />);

    const worlds = await screen.findByTestId('eidoverse-source-worlds');
    expect(worlds).toHaveTextContent('Upstream check unavailable');
    expect(worlds).toHaveTextContent('fork freshness is unknown');
    expect(screen.getByText('Remote freshness is unknown; a managed update can retry both repositories.')).toBeInTheDocument();
  });
});

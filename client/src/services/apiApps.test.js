import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/ui/Toast', () => ({
  default: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

const mockNetwork = vi.hoisted(() => ({ getNetworkExposure: vi.fn() }));
vi.mock('./apiSystem.js', () => mockNetwork);

import toast from '../components/ui/Toast';
import { getPreferredSelfRestartOrigin, handleSelfRestart } from './apiApps';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockNetwork.getNetworkExposure.mockResolvedValue({ setup: { trustedUrl: null } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('handleSelfRestart', () => {
  it('polls and navigates on the new HTTPS origin after a TLS-enabling restart', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    const assign = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('location', {
      pathname: '/instances',
      search: '?view=peers',
      hash: '#https',
      assign,
      reload: vi.fn(),
    });

    handleSelfRestart({ targetOrigin: 'https://host-alpha.example-tailnet.ts.net:5555/' });

    expect(toast.loading).toHaveBeenCalledWith('Restarting PortOS...', {
      id: 'self-restart',
      duration: Infinity,
    });

    await vi.advanceTimersByTimeAsync(2000);

    expect(fetch).toHaveBeenCalledWith(
      'https://host-alpha.example-tailnet.ts.net:5555/api/system/health',
      { mode: 'no-cors' }
    );
    expect(toast.success).toHaveBeenCalledWith('PortOS restarted successfully', {
      id: 'self-restart',
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(assign).toHaveBeenCalledWith(
      'https://host-alpha.example-tailnet.ts.net:5555/instances?view=peers#https'
    );
  });
});

describe('getPreferredSelfRestartOrigin', () => {
  it('returns the active trusted origin supplied by network exposure', async () => {
    mockNetwork.getNetworkExposure.mockResolvedValueOnce({
      setup: { trustedUrl: 'https://host-alpha.example-tailnet.ts.net:5555' },
    });

    await expect(getPreferredSelfRestartOrigin()).resolves.toBe(
      'https://host-alpha.example-tailnet.ts.net:5555',
    );
    expect(mockNetwork.getNetworkExposure).toHaveBeenCalledWith({ silent: true });
  });

  it('does not turn an unavailable or non-HTTPS setup value into a restart target', async () => {
    mockNetwork.getNetworkExposure.mockResolvedValueOnce({
      setup: { pendingTrustedUrl: 'https://host-alpha.example-tailnet.ts.net:5555', trustedUrl: null },
    });

    await expect(getPreferredSelfRestartOrigin()).resolves.toBeNull();
  });
});

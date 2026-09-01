import { describe, expect, it, vi } from 'vitest';
import { navigateWithRetry } from './open-ui-in-browser.js';

const baseOpts = {
  navigateUrl: 'http://localhost:5553/api/browser/navigate',
  targetUrl: 'https://host.example-tailnet.ts.net:5555',
  totalTimeoutMs: 10_000,
  intervalMs: 1_000,
  attemptTimeoutMs: 1_000,
  sleep: vi.fn().mockResolvedValue(undefined),
};

describe('navigateWithRetry', () => {
  it('resolves immediately when the first attempt succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await navigateWithRetry({ ...baseOpts, fetchImpl });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(baseOpts.sleep).not.toHaveBeenCalled();
  });

  it('retries past a cold-launching browser (Chrome not up yet) and eventually succeeds', async () => {
    // Simulates the update.sh race: Chrome is still cold-launching so the first
    // couple of navigate attempts fail (connection refused), then CDP comes up.
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await navigateWithRetry({ ...baseOpts, sleep, fetchImpl });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('gives up once the total retry budget is exhausted, returning the last failure', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = vi.fn().mockImplementation(async (ms) => { now += ms; });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await navigateWithRetry({
      ...baseOpts,
      totalTimeoutMs: 3_000,
      intervalMs: 1_000,
      sleep,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('connect ECONNREFUSED');
    // Budget of 3000ms at 1000ms/attempt: attempts stop once the next sleep
    // would cross the deadline, so it must not spin forever.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0);
    expect(fetchImpl.mock.calls.length).toBeLessThan(10);

    vi.restoreAllMocks();
  });

  it('treats a non-ok HTTP response (e.g. UNSAFE_URL 400) as a retryable failure, not a throw', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"UNSAFE_URL"}'),
    });
    const result = await navigateWithRetry({ ...baseOpts, totalTimeoutMs: 500, intervalMs: 1000, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toContain('UNSAFE_URL');
  });
});

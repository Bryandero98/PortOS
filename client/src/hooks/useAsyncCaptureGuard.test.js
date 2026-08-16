import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useAsyncCaptureGuard from './useAsyncCaptureGuard.js';

describe('useAsyncCaptureGuard', () => {
  it('allows one pending start and settles the current generation', () => {
    const teardown = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() => useAsyncCaptureGuard({ teardown, onCancel }));

    let firstGeneration;
    let secondGeneration;
    act(() => {
      firstGeneration = result.current.tryStart();
      secondGeneration = result.current.tryStart();
    });

    expect(firstGeneration).toBe(1);
    expect(secondGeneration).toBeNull();
    expect(result.current.isCurrent(firstGeneration)).toBe(true);

    act(() => { result.current.settleStart(firstGeneration); });
    expect(result.current.tryStart()).toBe(2);
  });

  it('invalidates stale generations and delegates cancellation cleanup', () => {
    const teardown = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() => useAsyncCaptureGuard({ teardown, onCancel }));

    const firstGeneration = result.current.tryStart();
    act(() => { result.current.cancel(); });

    expect(result.current.isCurrent(firstGeneration)).toBe(false);
    expect(result.current.settleStart(firstGeneration)).toBe(false);
    expect(teardown).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();

    expect(result.current.tryStart()).toBe(3);
  });
});

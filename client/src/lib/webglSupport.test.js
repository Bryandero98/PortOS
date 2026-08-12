import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetWebGLAvailableCache, isWebGLAvailable } from './webglSupport.js';

afterEach(() => {
  __resetWebGLAvailableCache();
  vi.restoreAllMocks();
});

describe('isWebGLAvailable', () => {
  it('returns true when webgl2 context can be created', () => {
    const lose = { loseContext: vi.fn() };
    const gl = { getExtension: vi.fn(() => lose) };
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: (type) => (type === 'webgl2' ? gl : null),
    });
    expect(isWebGLAvailable()).toBe(true);
    expect(lose.loseContext).toHaveBeenCalled();
    // Memoized
    expect(isWebGLAvailable()).toBe(true);
    expect(document.createElement).toHaveBeenCalledTimes(1);
  });

  it('falls back to webgl when webgl2 is missing', () => {
    const gl = { getExtension: vi.fn(() => null) };
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: (type) => (type === 'webgl' ? gl : null),
    });
    expect(isWebGLAvailable()).toBe(true);
  });

  it('returns false when no context can be created', () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => null,
    });
    expect(isWebGLAvailable()).toBe(false);
  });

  it('returns false when getContext throws', () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: () => {
        throw new Error('WebGL disabled');
      },
    });
    expect(isWebGLAvailable()).toBe(false);
  });
});

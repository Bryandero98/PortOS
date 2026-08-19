import { describe, it, expect } from 'vitest';
import { resolveOpenWorldFocus } from './openWorldFocusState';

const apps = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
];

describe('resolveOpenWorldFocus', () => {
  it('reports no focus when there is no appId (overview)', () => {
    expect(resolveOpenWorldFocus(null, apps)).toEqual({ hasFocus: false, focusedApp: null, notFound: false });
    expect(resolveOpenWorldFocus('', apps)).toEqual({ hasFocus: false, focusedApp: null, notFound: false });
    expect(resolveOpenWorldFocus(undefined, apps)).toEqual({ hasFocus: false, focusedApp: null, notFound: false });
  });

  it('resolves a valid id to its app', () => {
    const res = resolveOpenWorldFocus('beta', apps);
    expect(res.hasFocus).toBe(true);
    expect(res.focusedApp).toBe(apps[1]);
    expect(res.notFound).toBe(false);
  });

  it('does NOT flag not-found while the app list is still loading (deep link + reload)', () => {
    const res = resolveOpenWorldFocus('beta', [], { loading: true });
    expect(res.hasFocus).toBe(true);
    expect(res.focusedApp).toBeNull();
    expect(res.notFound).toBe(false);
  });

  it('flags not-found for a stale/deleted id once loading has finished', () => {
    const res = resolveOpenWorldFocus('ghost', apps, { loading: false });
    expect(res.hasFocus).toBe(true);
    expect(res.focusedApp).toBeNull();
    expect(res.notFound).toBe(true);
  });

  it('tolerates a non-array app list', () => {
    expect(resolveOpenWorldFocus('alpha', null, { loading: false })).toEqual({
      hasFocus: true,
      focusedApp: null,
      notFound: true,
    });
  });
});
// @vitest-environment node

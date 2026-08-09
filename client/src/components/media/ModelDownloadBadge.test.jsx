import { describe, expect, it } from 'vitest';
import { deriveSizeEstimate } from './ModelDownloadBadge.jsx';

describe('deriveSizeEstimate', () => {
  it('preserves decimal and binary gigabyte labels', () => {
    expect(deriveSizeEstimate('Example model (~8 GB)')).toBe('~8 GB');
    expect(deriveSizeEstimate('Wan 2.2 (~16.9 GiB download)')).toBe('~16.9 GiB');
  });

  it('returns null when no estimate is embedded', () => {
    expect(deriveSizeEstimate('Example model')).toBeNull();
    expect(deriveSizeEstimate(null)).toBeNull();
  });
});

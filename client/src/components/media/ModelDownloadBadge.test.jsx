import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ModelDownloadBadge, { deriveSizeEstimate } from './ModelDownloadBadge.jsx';

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

describe('ModelDownloadBadge', () => {
  it('disables a gated download and explains why', () => {
    const onDownload = vi.fn();
    render(<ModelDownloadBadge
      status={{ repo: 'example/model', cached: false }}
      onDownload={onDownload}
      disabled
      disabledReason="Accept the model terms first"
      disabledReasonId="model-terms"
    />);
    const button = screen.getByRole('button', { name: /Download/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Accept the model terms first');
    expect(button).toHaveAttribute('aria-describedby', 'model-terms');
    fireEvent.click(button);
    expect(onDownload).not.toHaveBeenCalled();
  });
});

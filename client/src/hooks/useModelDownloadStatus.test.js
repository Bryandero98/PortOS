import { describe, expect, it } from 'vitest';
import { buildDownloadUrl, TEXT_ENCODER_DOWNLOAD_ID } from './useModelDownloadStatus.js';

describe('buildDownloadUrl', () => {
  it('carries the exact terms key on a model download', () => {
    expect(buildDownloadUrl(
      'video',
      'minimax_h3_8bit',
      false,
      'minimax-h3-community-license-2026-08-02',
    )).toBe('/api/video-gen/models/minimax_h3_8bit/download?termsAcceptance=minimax-h3-community-license-2026-08-02');
  });

  it('combines repair and acceptance query parameters without changing special routes', () => {
    expect(buildDownloadUrl('video', 'minimax_h3_8bit', true, 'license v1')).toBe(
      '/api/video-gen/models/minimax_h3_8bit/download?force=1&termsAcceptance=license+v1',
    );
    expect(buildDownloadUrl('video', TEXT_ENCODER_DOWNLOAD_ID, true)).toBe(
      '/api/video-gen/text-encoder/download?force=1',
    );
  });
});

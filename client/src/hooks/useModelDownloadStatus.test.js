import { describe, expect, it } from 'vitest';
import { buildDownloadUrl, TEXT_ENCODER_DOWNLOAD_ID } from './useModelDownloadStatus.js';

describe('buildDownloadUrl', () => {
  it('builds a plain model download URL', () => {
    // A restricted model's license acknowledgement is NOT a query parameter —
    // the server resolves it from the install record, so a download can't be
    // self-authorized by whoever builds this URL.
    expect(buildDownloadUrl('video', 'minimax_h3_8bit')).toBe(
      '/api/video-gen/models/minimax_h3_8bit/download',
    );
  });

  it('adds the repair force flag without changing special routes', () => {
    expect(buildDownloadUrl('video', 'minimax_h3_8bit', true)).toBe(
      '/api/video-gen/models/minimax_h3_8bit/download?force=1',
    );
    expect(buildDownloadUrl('video', TEXT_ENCODER_DOWNLOAD_ID, true)).toBe(
      '/api/video-gen/text-encoder/download?force=1',
    );
  });
});

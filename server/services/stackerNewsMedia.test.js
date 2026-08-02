import { describe, expect, it, vi } from 'vitest';

const fetchPublicBinary = vi.fn();
vi.mock('../lib/safeUrlFetch.js', () => ({ fetchPublicBinary }));
const { fetchAndNormalizeStackerNewsImage } = await import('./stackerNewsMedia.js');

describe('Stacker News remote media', () => {
  it('uses the strict public fetch posture and rejects active formats before decoding', async () => {
    fetchPublicBinary.mockResolvedValue({ buffer: Buffer.from('<svg/>'), contentType: 'image/svg+xml' });
    await expect(fetchAndNormalizeStackerNewsImage('https://example.com/image.svg')).rejects.toThrow('Unsupported');
    expect(fetchPublicBinary).toHaveBeenCalledWith('https://example.com/image.svg', expect.objectContaining({ blockPrivate: true, maxBytes: 5 * 1024 * 1024 }));
  });
});

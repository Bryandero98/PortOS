import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOrOpenPage: vi.fn(), isAuthPage: vi.fn(), evaluateOnPage: vi.fn(), readJSONFile: vi.fn(), ensureDir: vi.fn(), atomicWrite: vi.fn(),
}));
vi.mock('./browserService.js', () => ({
  findOrOpenPage: (...args) => mocks.findOrOpenPage(...args), isAuthPage: (...args) => mocks.isAuthPage(...args),
  evaluateOnPage: (...args) => mocks.evaluateOnPage(...args),
}));
vi.mock('../lib/fileUtils.js', () => ({
  dataPath: (...parts) => `/tmp/${parts.join('/')}`, readJSONFile: (...args) => mocks.readJSONFile(...args),
  ensureDir: (...args) => mocks.ensureDir(...args), atomicWrite: (...args) => mocks.atomicWrite(...args), sleep: vi.fn(async () => {}),
}));

import { normalizeYoutubePlaylist, normalizeYoutubeVideo, youtubePlaylistIdFromUrl, youtubePlaylistSnapshotSummary, syncYoutubePlaylists } from './youtubePlaylists.js';

describe('YouTube playlist normalization', () => {
  it('extracts playlist ids and produces downloader-ready video URLs', () => {
    expect(youtubePlaylistIdFromUrl('https://www.youtube.com/playlist?list=PL-example')).toBe('PL-example');
    expect(youtubePlaylistIdFromUrl('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(normalizeYoutubeVideo({ id: 'video-1', title: 'Example video', channel: 'Example channel' })).toMatchObject({
      id: 'video-1', url: 'https://www.youtube.com/watch?v=video-1',
    });
    expect(normalizeYoutubePlaylist({ id: 'PL-example', name: 'Example playlist' }, [{ id: 'video-1' }])).toMatchObject({
      id: 'PL-example', videoCount: 1, videos: [{ id: 'video-1' }],
    });
  });
  it('summarizes a missing snapshot as unsynced', () => {
    expect(youtubePlaylistSnapshotSummary(null)).toEqual({ playlistCount: 0, videoCount: 0, syncedAt: null, warningCount: 0 });
  });
});

describe('syncYoutubePlaylists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOrOpenPage.mockResolvedValue({ id: 'page-1', url: 'https://www.youtube.com/feed/playlists' });
    mocks.isAuthPage.mockReturnValue(false);
    mocks.readJSONFile.mockResolvedValue(null);
    mocks.evaluateOnPage
      .mockResolvedValueOnce({ signedOut: false, playlists: [{ id: 'PL-example', name: 'Example playlist', videoCount: 1 }] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, videos: [{ id: 'video-1', title: 'Example video', channel: 'Example channel' }] });
  });
  it('scrapes playlist pages and writes a local video snapshot', async () => {
    const result = await syncYoutubePlaylists();
    expect(result).toMatchObject({ ok: true, playlistCount: 1, videoCount: 1, scanned: 1, failed: 0 });
    expect(mocks.findOrOpenPage).toHaveBeenCalledWith('https://www.youtube.com/feed/playlists');
    expect(mocks.atomicWrite).toHaveBeenCalledWith('/tmp/youtube/playlists.json', expect.objectContaining({ schemaVersion: 1 }));
  });
});

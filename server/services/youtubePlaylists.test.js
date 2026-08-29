import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOrOpenPage: vi.fn(), listCdpPages: vi.fn(), isAuthPage: vi.fn(), evaluateOnPage: vi.fn(), readJSONFile: vi.fn(), ensureDir: vi.fn(), atomicWrite: vi.fn(),
}));
vi.mock('./browserService.js', () => ({
  findOrOpenPage: (...args) => mocks.findOrOpenPage(...args), listCdpPages: (...args) => mocks.listCdpPages(...args), isAuthPage: (...args) => mocks.isAuthPage(...args),
  evaluateOnPage: (...args) => mocks.evaluateOnPage(...args),
}));
vi.mock('../lib/fileUtils.js', () => ({
  dataPath: (...parts) => `/tmp/${parts.join('/')}`, readJSONFile: (...args) => mocks.readJSONFile(...args),
  ensureDir: (...args) => mocks.ensureDir(...args), atomicWrite: (...args) => mocks.atomicWrite(...args), sleep: vi.fn(async () => {}),
}));

import { normalizeYoutubePlaylist, normalizeYoutubeVideo, youtubePlaylistSnapshotSummary, syncYoutubePlaylists } from './youtubePlaylists.js';

describe('YouTube playlist normalization', () => {
  it('produces downloader-ready video URLs', () => {
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
    mocks.listCdpPages.mockResolvedValue([]);
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
    expect(mocks.evaluateOnPage.mock.calls[0][1]).toContain('/accounts\\.google\\.com|\\/ServiceLogin/i');
    expect(mocks.atomicWrite).toHaveBeenCalledWith('/tmp/youtube/playlists.json', expect.objectContaining({ schemaVersion: 1 }));
  });

  it('navigates an existing YouTube tab to the playlists feed', async () => {
    mocks.findOrOpenPage.mockResolvedValue({ id: 'page-1', url: 'https://www.youtube.com/watch?v=video-1' });
    mocks.listCdpPages.mockResolvedValue([{ id: 'page-1', url: 'https://www.youtube.com/feed/playlists' }]);
    mocks.readJSONFile.mockResolvedValue(null);
    mocks.evaluateOnPage
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, playlists: [{ id: 'PL-example', name: 'Example playlist' }] })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ signedOut: false, videos: [] });

    await syncYoutubePlaylists();

    expect(mocks.evaluateOnPage.mock.calls[0][1]).toContain('location.assign("https://www.youtube.com/feed/playlists")');
    expect(mocks.listCdpPages).toHaveBeenCalledTimes(1);
  });

  it('keeps the prior snapshot when playlist extraction is unexpectedly empty', async () => {
    mocks.readJSONFile.mockResolvedValue({
      syncedAt: '2026-08-28T00:00:00.000Z',
      playlists: [{ id: 'PL-example', name: 'Example playlist', videos: [{ id: 'video-1' }] }],
    });
    mocks.evaluateOnPage.mockReset().mockResolvedValueOnce({ signedOut: false, playlists: [] });

    const result = await syncYoutubePlaylists();

    expect(result).toMatchObject({ ok: false, status: 'extraction-empty', playlistCount: 1, videoCount: 1 });
    expect(mocks.atomicWrite).not.toHaveBeenCalled();
  });
});

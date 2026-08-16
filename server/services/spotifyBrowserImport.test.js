import { beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({
  closeCdpPage: vi.fn(),
  deleteDownload: vi.fn(),
  evaluateOnPage: vi.fn(),
  getDownloads: vi.fn(),
  listCdpPages: vi.fn(),
  navigateToUrlPinned: vi.fn(),
  resolveDownload: vi.fn(),
}));
const spotify = vi.hoisted(() => ({ readSpotifyRecords: vi.fn() }));
const digitalTwin = vi.hoisted(() => ({ analyzeImportedData: vi.fn() }));

vi.mock('./browserService.js', () => browser);
vi.mock('./spotifyImport.js', () => spotify);
vi.mock('./digital-twin-import.js', () => digitalTwin);

import {
  importSpotifyFromBrowser,
  isSpotifyDownloadName,
  isSpotifyLoginPage,
  isSpotifyPrivacyPage,
  openSpotifyBrowser,
  SPOTIFY_PRIVACY_URL,
} from './spotifyBrowserImport.js';

const PRIVACY_PAGE = {
  id: 'tab-1',
  url: 'https://www.spotify.com/us/account/privacy/',
};

describe('Spotify browser import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browser.closeCdpPage.mockResolvedValue(undefined);
    browser.deleteDownload.mockResolvedValue(true);
  });

  it('recognizes only fixed Spotify page states and export names', () => {
    expect(isSpotifyPrivacyPage(PRIVACY_PAGE)).toBe(true);
    expect(isSpotifyPrivacyPage({ url: 'https://evil.example/account/privacy/' })).toBe(false);
    expect(isSpotifyLoginPage({ url: 'https://accounts.spotify.com/login' })).toBe(true);
    expect(isSpotifyLoginPage({ url: 'https://accounts.spotify.com.evil.example/login' })).toBe(false);
    expect(isSpotifyDownloadName('my_spotify_data.zip')).toBe(true);
    expect(isSpotifyDownloadName('Spotify Extended Streaming History.json')).toBe(true);
    expect(isSpotifyDownloadName('unrelated.json')).toBe(false);
    expect(isSpotifyDownloadName('spotify-data.exe')).toBe(false);
  });

  it('opens the fixed privacy page through pinned CDP navigation when no Spotify tab exists', async () => {
    browser.listCdpPages.mockResolvedValue([]);
    browser.navigateToUrlPinned.mockResolvedValue(PRIVACY_PAGE);
    browser.evaluateOnPage.mockResolvedValue({
      privacyPage: true,
      loginForm: false,
      hasExtendedHistory: true,
      hasDownloadAction: true,
      requestPending: false,
    });

    const result = await openSpotifyBrowser();

    expect(browser.navigateToUrlPinned).toHaveBeenCalledWith(
      SPOTIFY_PRIVACY_URL,
      expect.objectContaining({ closeAfterRead: false, settleMs: expect.any(Number) }),
    );
    const verifyRemoteIp = browser.navigateToUrlPinned.mock.calls[0][1].verifyRemoteIp;
    expect(verifyRemoteIp('93.184.216.34')).toBe(true);
    expect(verifyRemoteIp('127.0.0.1')).toBe(false);
    expect(result).toMatchObject({ status: 'ready', pageId: 'tab-1' });
  });

  it('returns auth-required without evaluating a Spotify login page', async () => {
    const loginPage = { id: 'tab-login', url: 'https://accounts.spotify.com/login' };
    browser.listCdpPages.mockResolvedValue([loginPage]);

    const result = await openSpotifyBrowser();

    expect(result).toMatchObject({ status: 'auth-required', pageId: 'tab-login' });
    expect(browser.evaluateOnPage).not.toHaveBeenCalled();
    expect(browser.navigateToUrlPinned).not.toHaveBeenCalled();
  });

  it('closes a pinned navigation that leaves Spotify before exposing it', async () => {
    const unexpectedPage = { id: 'tab-evil', url: 'https://example.com/redirected' };
    browser.listCdpPages.mockResolvedValue([]);
    browser.navigateToUrlPinned.mockResolvedValue(unexpectedPage);

    const result = await openSpotifyBrowser();

    expect(browser.closeCdpPage).toHaveBeenCalledWith('tab-evil');
    expect(result.status).toBe('no-browser');
  });

  it('analyzes a newly downloaded Spotify archive and removes the raw file', async () => {
    browser.listCdpPages.mockResolvedValue([PRIVACY_PAGE]);
    browser.evaluateOnPage
      .mockResolvedValueOnce({
        privacyPage: true,
        loginForm: false,
        hasExtendedHistory: true,
        hasDownloadAction: true,
        requestPending: false,
      })
      .mockResolvedValueOnce({ clicked: true, extendedSelected: true });
    browser.getDownloads
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [{ name: 'my_spotify_data.zip', modified: new Date().toISOString() }] });
    browser.resolveDownload.mockResolvedValue({
      absPath: '/safe/browser-downloads/my_spotify_data.zip',
      name: 'my_spotify_data.zip',
      mime: 'application/zip',
    });
    spotify.readSpotifyRecords.mockResolvedValue([
      { ts: '2026-01-01T00:00:00Z', master_metadata_track_name: 'Example Track' },
    ]);
    digitalTwin.analyzeImportedData.mockResolvedValue({
      source: 'spotify',
      itemCount: 1,
      rawSummary: 'Example summary',
    });

    const result = await importSpotifyFromBrowser('local', 'example-model', { waitMs: 0 });

    expect(spotify.readSpotifyRecords).toHaveBeenCalledWith(expect.objectContaining({
      path: '/safe/browser-downloads/my_spotify_data.zip',
      originalname: 'my_spotify_data.zip',
    }));
    expect(digitalTwin.analyzeImportedData).toHaveBeenCalledWith(
      'spotify',
      expect.stringContaining('Example Track'),
      'local',
      'example-model',
    );
    expect(browser.deleteDownload).toHaveBeenCalledWith('my_spotify_data.zip');
    expect(result).toMatchObject({ status: 'complete', downloaded: true, itemCount: 1 });
  });

  it('keeps an already-requested package in the pending state', async () => {
    browser.listCdpPages.mockResolvedValue([PRIVACY_PAGE]);
    browser.evaluateOnPage
      .mockResolvedValueOnce({
        privacyPage: true,
        loginForm: false,
        hasExtendedHistory: true,
        hasDownloadAction: true,
        requestPending: false,
      })
      .mockResolvedValueOnce({ clicked: false, requestPending: true, extendedSelected: false });
    browser.getDownloads.mockResolvedValue({ files: [] });

    const result = await importSpotifyFromBrowser('local', 'example-model', { waitMs: 0 });

    expect(result).toMatchObject({ status: 'pending', downloadTriggered: false });
    expect(digitalTwin.analyzeImportedData).not.toHaveBeenCalled();
  });
});

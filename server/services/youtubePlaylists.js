/**
 * YouTube playlist and saved-video reference ingestion for Brain.
 *
 * YouTube has no usable watch-history API for this feature, so this follows the
 * existing managed-browser boundary used by youtubeSync. The snapshot is local
 * to this install and contains only bounded display metadata plus source URLs;
 * video bytes are fetched only after the user explicitly starts a download.
 */
import { dataPath, ensureDir, atomicWrite, readJSONFile, sleep } from '../lib/fileUtils.js';
import { findOrOpenPage, isAuthPage, evaluateOnPage } from './browserService.js';

const PLAYLISTS_URL = 'https://www.youtube.com/feed/playlists';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=';
const PLAYLISTS_FILE = dataPath('youtube', 'playlists.json');
const SNAPSHOT_VERSION = 1;
const MAX_PLAYLISTS = 100;
const MAX_VIDEOS_PER_PLAYLIST = 200;
const NAV_SETTLE_MS = 2500;

export function youtubePlaylistIdFromUrl(value) {
  const match = /^(?:https?:\/\/)(?:www\.)?youtube\.com\/playlist\?[^#]*\blist=([^&#]+)/i.exec(String(value || ''));
  return match ? match[1] : null;
}

export function normalizeYoutubeVideo(raw) {
  if (!raw?.id || !raw?.title) return null;
  return {
    id: raw.id,
    title: raw.title,
    channel: raw.channel || null,
    thumbnail: raw.thumbnail && /^https:\/\//i.test(raw.thumbnail) ? raw.thumbnail : null,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(raw.id)}`,
    duration: raw.duration || null,
  };
}

export function normalizeYoutubePlaylist(raw, videos = []) {
  if (!raw?.id || !raw?.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    videoCount: Number.isFinite(raw.videoCount) ? raw.videoCount : videos.length,
    url: `https://www.youtube.com/playlist?list=${encodeURIComponent(raw.id)}`,
    thumbnail: raw.thumbnail && /^https:\/\//i.test(raw.thumbnail) ? raw.thumbnail : null,
    videos,
  };
}

export function youtubePlaylistSnapshotSummary(snapshot) {
  const playlists = Array.isArray(snapshot?.playlists) ? snapshot.playlists : [];
  return {
    playlistCount: playlists.length,
    videoCount: playlists.reduce((total, playlist) => total + (playlist.videos?.length || 0), 0),
    syncedAt: snapshot?.syncedAt || null,
    warningCount: Array.isArray(snapshot?.warnings) ? snapshot.warnings.length : 0,
  };
}

function buildPlaylistsExtractionScript() {
  return `
    (async () => {
      const signedOut = /accounts\.google\.com|\/ServiceLogin/i.test(location.href)
        || (!!document.querySelector('a[href*="ServiceLogin"]') && !document.querySelector('#avatar-btn, button#avatar-btn, #masthead #avatar'));
      if (signedOut) return { signedOut: true, playlists: [] };
      const abs = (href) => { try { return new URL(href, location.origin).href; } catch { return href || null; } };
      const seen = new Set();
      const playlists = [];
      const collect = () => Array.from(document.querySelectorAll('ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-playlist-card-renderer')).map((card) => {
        const link = Array.from(card.querySelectorAll('a[href*="list="]'))[0];
        const url = link ? abs(link.getAttribute('href')) : null;
        let id = null;
        try { id = url ? new URL(url).searchParams.get('list') : null; } catch {}
        const titleEl = card.querySelector('a#video-title, #video-title, #video-title-link');
        const image = card.querySelector('img');
        const text = (card.textContent || '').replace(/\\s+/g, ' ').trim();
        const count = text.match(/([\\d,]+)\\s+videos?/i);
        return { id, name: (titleEl?.textContent || link?.textContent || '').trim(), videoCount: count ? Number(count[1].replace(/,/g, '')) : null, thumbnail: image?.src || image?.getAttribute('data-thumb') || null };
      });
      const append = (items) => items.forEach((item) => {
        if (item.id && !seen.has(item.id)) { seen.add(item.id); playlists.push(item); }
      });
      append(collect());
      // Playlist pages hydrate additional cards as the feed scrolls. Keep the
      // scrape bounded while giving the page a chance to reveal them.
      let previousHeight = 0;
      for (let i = 0; i < 8 && playlists.length < ${MAX_PLAYLISTS}; i++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const height = document.documentElement.scrollHeight;
        if (height === previousHeight) break;
        previousHeight = height;
        append(collect());
      }
      if (playlists.length === 0) return { signedOut: false, playlists: [] };
      return { signedOut: false, playlists: playlists.slice(0, ${MAX_PLAYLISTS}) };
    })()
  `;
}

function buildPlaylistVideosExtractionScript() {
  return `
    (async () => {
      const signedOut = /accounts\.google\.com|\/ServiceLogin/i.test(location.href)
        || (!!document.querySelector('a[href*="ServiceLogin"]') && !document.querySelector('#avatar-btn, button#avatar-btn, #masthead #avatar'));
      if (signedOut) return { signedOut: true, videos: [] };
      const abs = (href) => { try { return new URL(href, location.origin).href; } catch { return href || null; } };
      const seen = new Set();
      const videos = [];
      const collect = () => Array.from(document.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-grid-video-renderer')).map((row) => {
        const titleEl = row.querySelector('a#video-title, a#video-title-link');
        const url = titleEl ? abs(titleEl.getAttribute('href')) : null;
        let id = null;
        try { id = url ? new URL(url).searchParams.get('v') : null; } catch {}
        const channelEl = row.querySelector('#byline a, ytd-channel-name a, #channel-name a');
        const image = row.querySelector('img');
        const durationEl = row.querySelector('ytd-thumbnail-overlay-time-status-renderer span, #text.ytd-thumbnail-overlay-time-status-renderer');
        return { id, title: (titleEl?.textContent || '').trim(), channel: (channelEl?.textContent || '').trim() || null, thumbnail: image?.src || image?.getAttribute('data-thumb') || null, duration: (durationEl?.textContent || '').trim() || null };
      });
      const append = (items) => items.forEach((item) => {
        if (item.id && !seen.has(item.id)) { seen.add(item.id); videos.push(item); }
      });
      append(collect());
      let previousHeight = 0;
      for (let i = 0; i < 12 && videos.length < ${MAX_VIDEOS_PER_PLAYLIST}; i++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const height = document.documentElement.scrollHeight;
        if (height === previousHeight) break;
        previousHeight = height;
        append(collect());
      }
      return { signedOut: false, videos: videos.slice(0, ${MAX_VIDEOS_PER_PLAYLIST}) };
    })()
  `;
}

async function loadPage(url) {
  const page = await findOrOpenPage(url).catch(() => null);
  if (!page || isAuthPage(page)) return { page: null, status: page ? 'auth-required' : 'no-browser' };
  return { page, status: 'ok' };
}

export async function getStoredYoutubePlaylists() {
  return readJSONFile(PLAYLISTS_FILE, null);
}

let syncInFlight = null;

export async function syncYoutubePlaylists() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doSyncYoutubePlaylists().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doSyncYoutubePlaylists() {
  const loaded = await loadPage(PLAYLISTS_URL);
  if (!loaded.page) {
    return loaded.status === 'auth-required'
      ? { ok: false, status: loaded.status, needsAuth: true, error: 'Signed out of YouTube', remediation: 'Log into YouTube in the managed browser, then sync playlists again.' }
      : { ok: false, status: loaded.status, error: 'Managed browser is not running', remediation: 'Start the managed browser, then sync playlists again.' };
  }

  const extracted = await evaluateOnPage(loaded.page, buildPlaylistsExtractionScript()).catch(() => null);
  if (!extracted || !Array.isArray(extracted.playlists)) {
    return { ok: false, status: 'extraction-failed', error: 'Could not read YouTube playlists — the page layout may have changed.' };
  }
  if (extracted.signedOut) {
    return { ok: false, status: 'auth-required', needsAuth: true, error: 'Signed out of YouTube', remediation: 'Log into YouTube in the managed browser, then sync playlists again.' };
  }

  const previous = await getStoredYoutubePlaylists();
  const playlists = [];
  const warnings = [];
  const sourcePlaylists = extracted.playlists.filter((playlist) => playlist?.id && playlist?.name);
  for (const rawPlaylist of sourcePlaylists) {
    const navigated = await evaluateOnPage(loaded.page, `location.assign(${JSON.stringify(`${PLAYLIST_URL}${encodeURIComponent(rawPlaylist.id)}`)}); true`).catch(() => false);
    if (!navigated) {
      warnings.push(`${rawPlaylist.name || 'Playlist'}: could not open playlist`);
      continue;
    }
    await sleep(NAV_SETTLE_MS);
    const detail = await evaluateOnPage(loaded.page, buildPlaylistVideosExtractionScript()).catch(() => null);
    if (!detail || !Array.isArray(detail.videos) || detail.signedOut) {
      warnings.push(`${rawPlaylist.name || 'Playlist'}: could not read videos`);
      const stale = previous?.playlists?.find((playlist) => playlist.id === rawPlaylist.id);
      if (stale) playlists.push(stale);
      continue;
    }
    const normalizedVideos = detail.videos.map(normalizeYoutubeVideo).filter(Boolean);
    const playlist = normalizeYoutubePlaylist(rawPlaylist, normalizedVideos);
    if (playlist) playlists.push(playlist);
  }

  const snapshot = {
    schemaVersion: SNAPSHOT_VERSION,
    syncedAt: new Date().toISOString(),
    playlists,
    warnings,
  };
  await ensureDir(dataPath('youtube'));
  await atomicWrite(PLAYLISTS_FILE, snapshot);

  const summary = youtubePlaylistSnapshotSummary(snapshot);
  const result = {
    ok: warnings.length === 0,
    ...summary,
    scanned: sourcePlaylists.length,
    failed: warnings.length,
    ...(warnings.length ? { warnings } : {}),
  };
  console.log(`📺 YouTube playlists: synced ${summary.playlistCount} playlist(s), ${summary.videoCount} video(s)${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
  return result;
}

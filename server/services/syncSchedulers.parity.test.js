import { describe, it, expect, vi, beforeEach } from 'vitest';

// Parity guard for the shared factory refactor (#4883): the four settings-gated
// ingestion schedulers now differ only in the options they hand
// `createSyncScheduler`, which makes an id/emoji/source copy-paste swap between
// domains invisible at a glance. Pin each domain's registered event here.
const scheduleMock = vi.fn();
vi.mock('./eventScheduler.js', () => ({ schedule: (...args) => scheduleMock(...args) }));

const enabledConfig = async () => ({ enabled: true, intervalMinutes: 25 });
vi.mock('./imessageSync.js', () => ({ getImessageConfig: enabledConfig, runSync: vi.fn() }));
vi.mock('./signalSync.js', () => ({ getSignalConfig: enabledConfig, runSync: vi.fn() }));
vi.mock('./spotifySync.js', () => ({ getSpotifyConfig: enabledConfig, runSync: vi.fn() }));
vi.mock('./youtubeSync.js', () => ({ getYoutubeConfig: enabledConfig, runSync: vi.fn() }));

const { startImessageScheduler } = await import('./imessageScheduler.js');
const { startSignalScheduler } = await import('./signalScheduler.js');
const { startSpotifyScheduler } = await import('./spotifyScheduler.js');
const { startYoutubeScheduler } = await import('./youtubeScheduler.js');

const DOMAINS = [
  { name: 'iMessage', start: startImessageScheduler, id: 'imessage-sync', source: 'imessageScheduler', icon: '💬', label: 'iMessage' },
  { name: 'Signal', start: startSignalScheduler, id: 'signal-sync', source: 'signalScheduler', icon: '🔒', label: 'Signal' },
  { name: 'Spotify', start: startSpotifyScheduler, id: 'spotify-sync', source: 'spotifyScheduler', icon: '🎧', label: 'Spotify' },
  { name: 'YouTube', start: startYoutubeScheduler, id: 'youtube-sync', source: 'youtubeScheduler', icon: '📺', label: 'YouTube' },
];

beforeEach(() => {
  scheduleMock.mockClear();
});

describe.each(DOMAINS)('$name sync scheduler', ({ start, id, source, icon, label }) => {
  it('registers its own event id, metadata source, and log prefix', async () => {
    const logs = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => { logs.push(line); });

    await start();

    logSpy.mockRestore();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const [event] = scheduleMock.mock.calls[0];
    expect(event.id).toBe(id);
    expect(event.metadata).toEqual({ source });
    expect(logs).toContain(`${icon} ${label} sync scheduler: registered every 25min`);
  });
});

it('gives every domain a distinct event id', () => {
  expect(new Set(DOMAINS.map((d) => d.id)).size).toBe(DOMAINS.length);
});

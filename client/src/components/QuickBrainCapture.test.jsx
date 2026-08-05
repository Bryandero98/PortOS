import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  captureBrainThought: vi.fn(),
  getYoutubeIngestSettings: vi.fn(),
}));
// The ingest hook reaches for apiBrain directly (not through the `api` barrel),
// so mock it separately — that keeps the REAL useYoutubeIngest/useSseJobSlot
// wiring under test while never opening an EventSource.
vi.mock('../services/apiBrain.js', () => ({
  startYoutubeIngest: vi.fn(),
  cancelYoutubeIngest: vi.fn(),
  youtubeIngestEventsUrl: (jobId) => `/api/brain/youtube/ingest/${jobId}/events`,
}));
vi.mock('./ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

// jsdom has no EventSource, and once a kickoff resolves the real
// useSseProgress subscribes to one. A do-nothing stub keeps the hook wiring
// under test without inventing a fake transport — no test here drives frames.
class StubEventSource {
  static CLOSED = 2;
  constructor(url) { this.url = url; this.readyState = 0; }
  close() { this.readyState = StubEventSource.CLOSED; }
}
globalThis.EventSource = StubEventSource;

import { captureBrainThought, getYoutubeIngestSettings } from '../services/api';
import { startYoutubeIngest } from '../services/apiBrain.js';
import toast from './ui/Toast';
import QuickBrainCapture from './QuickBrainCapture';

const PLACEHOLDER = 'Thought, URL, or YouTube link...';
const YT = 'https://youtu.be/oCnxnaVg0bY';

const renderWidget = () => render(<MemoryRouter><QuickBrainCapture /></MemoryRouter>);

const type = (text) =>
  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: text } });

const submit = (text) => {
  type(text);
  fireEvent.click(screen.getByLabelText('Capture'));
};

// Open the advanced panel and wait for the settings-seeded checkbox state.
const openAdvanced = async () => {
  fireEvent.click(screen.getByLabelText('Toggle ingest options'));
  await waitFor(() => expect(getYoutubeIngestSettings).toHaveBeenCalled());
};

describe('QuickBrainCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    captureBrainThought.mockResolvedValue({ message: 'Saved to Links!' });
    getYoutubeIngestSettings.mockResolvedValue({
      defaultCaptureTranscript: true,
      defaultDownloadVideo: false,
      defaultIngestAudio: false,
    });
    startYoutubeIngest.mockResolvedValue({ jobId: 'job-1' });
  });

  it('captures both thoughts and URLs through the same endpoint', async () => {
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][0]).toBe('https://example.com');
  });

  it('surfaces the server message so a URL reads as saved to Links', async () => {
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Saved to Links!'));
  });

  it('does not flag a URL as creative even when the sticky flag is on', async () => {
    localStorage.setItem('brain.captureCreative', 'true');
    renderWidget();
    submit('https://example.com');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][3]).toEqual({ creative: false });
  });

  it('still flags ordinary text as creative when the flag is on', async () => {
    localStorage.setItem('brain.captureCreative', 'true');
    renderWidget();
    submit('a city that dreams');
    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][3]).toEqual({ creative: true });
  });

  it('hints which way the capture will go', () => {
    renderWidget();
    type('https://example.com');
    expect(screen.getByText('Will save as link')).toBeInTheDocument();
    type('call mom');
    expect(screen.getByText('Will capture as thought')).toBeInTheDocument();
  });

  describe('YouTube ingest path', () => {
    it('offers ingest options only for a single-video YouTube URL', () => {
      renderWidget();
      type('https://example.com/article');
      expect(screen.queryByLabelText('Toggle ingest options')).toBeNull();
      expect(screen.getByLabelText('Toggle creative capture mode')).toBeInTheDocument();

      type(YT);
      expect(screen.getByLabelText('Toggle ingest options')).toBeInTheDocument();
      // The creative flag is meaningless for an ingest — don't offer it.
      expect(screen.queryByLabelText('Toggle creative capture mode')).toBeNull();
    });

    it('treats a playlist URL as an ordinary link, not an ingest', () => {
      renderWidget();
      type('https://www.youtube.com/playlist?list=PLabcdefghij');
      expect(screen.queryByLabelText('Toggle ingest options')).toBeNull();
      expect(screen.getByText('Will save as link')).toBeInTheDocument();
    });

    it('seeds the option checkboxes from saved settings', async () => {
      getYoutubeIngestSettings.mockResolvedValue({
        defaultCaptureTranscript: true,
        defaultDownloadVideo: false,
        defaultIngestAudio: true,
      });
      renderWidget();
      type(YT);
      await openAdvanced();
      await waitFor(() => expect(screen.getByLabelText('Audio').checked).toBe(true));
      expect(screen.getByLabelText('Transcript').checked).toBe(true);
      expect(screen.getByLabelText('Video').checked).toBe(false);
    });

    it('submits the full ingest payload — options, prompt, and parsed tags', async () => {
      renderWidget();
      type(YT);
      await openAdvanced();

      fireEvent.change(screen.getByLabelText(/what should an agent do/i), {
        target: { value: 'Review for writing-tool improvements.' },
      });
      fireEvent.change(screen.getByLabelText(/^tags/i), { target: { value: ' writing-tools , research ,, ' } });
      fireEvent.click(screen.getByLabelText('Capture'));

      expect(captureBrainThought).not.toHaveBeenCalled();
      await waitFor(() => expect(startYoutubeIngest).toHaveBeenCalled());
      expect(startYoutubeIngest.mock.calls[0][0]).toEqual({
        url: YT,
        captureTranscript: true,
        downloadVideo: false,
        ingestAudio: false,
        agentPrompt: 'Review for writing-tool improvements.',
        // Blank entries dropped, surrounding whitespace trimmed.
        tags: ['writing-tools', 'research'],
      });
    });

    it('ingests with no prompt or tags when the panel was never opened', async () => {
      renderWidget();
      submit(YT);
      await waitFor(() => expect(startYoutubeIngest).toHaveBeenCalled());
      expect(startYoutubeIngest.mock.calls[0][0]).toEqual({
        url: YT,
        captureTranscript: true,
        downloadVideo: false,
        ingestAudio: false,
        agentPrompt: '',
        tags: [],
      });
    });

    it('refuses to start an ingest with every artifact unchecked', async () => {
      renderWidget();
      type(YT);
      await openAdvanced();
      fireEvent.click(screen.getByLabelText('Transcript'));
      fireEvent.click(screen.getByLabelText('Capture'));
      expect(startYoutubeIngest).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('Pick at least one of transcript, video, or audio');
    });
  });
});

import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the heavy children — this suite pins the MIDI read-through wiring
// (#2477 follow-up), not the editor/generation internals.
vi.mock('./ArtistPicker', () => ({ default: () => <div data-testid="artist-picker" /> }));
vi.mock('./MusicGenPanel', () => ({ default: () => <div data-testid="gen-panel" /> }));
vi.mock('./ChiptunePanel', () => ({ default: () => <div data-testid="chiptune-panel" /> }));
vi.mock('./TrackRenderCard', () => ({ default: () => <div data-testid="render-card" /> }));
vi.mock('./TrackRenderModal', () => ({ default: () => null }));
vi.mock('../songs/MidiVisualization.jsx', () => ({
  default: ({ url, model }) => <div data-testid="midi-viz" data-url={url} data-model={model} />,
}));

vi.mock('../../services/api', () => ({
  listTracks: vi.fn(),
  listAlbums: vi.fn(),
  createTrack: vi.fn(),
  updateTrack: vi.fn(),
  deleteTrack: vi.fn(),
  uploadTrackAudio: vi.fn(),
  attachTrackAudio: vi.fn(),
  listMusicLibrary: vi.fn(),
  selectTrackRender: vi.fn(),
  deleteTrackRender: vi.fn(),
  TRACK_TITLE_MAX: 200,
  TRACK_LYRICS_MAX: 10000,
  TRACK_PROMPT_MAX: 2000,
}));
vi.mock('../../services/apiMusicVideo.js', () => ({ listMusicVideoProjects: vi.fn() }));

import TracksManager from './TracksManager.jsx';
import { listTracks, listAlbums, createTrack } from '../../services/api';
import { listMusicVideoProjects } from '../../services/apiMusicVideo.js';

const TRACK = { id: 'track-1', title: 'Example Song', audioFilename: 'example.mp3', renders: [] };

const renderAt = (id) => render(
  <MemoryRouter initialEntries={[`/music/tracks/${id}`]}>
    <Routes>
      <Route path="/music/tracks/:id" element={<TracksManager />} />
    </Routes>
  </MemoryRouter>,
);

describe('<TracksManager> MIDI transcription read-through', () => {
  beforeEach(() => {
    listTracks.mockResolvedValue([TRACK]);
    listAlbums.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the newest linked Music Video transcription with a source link', async () => {
    listMusicVideoProjects.mockResolvedValue([
      { id: 'mv-old', name: 'Old Cut', trackId: 'track-1', midiTranscription: { filename: 'old.mid', model: 'small', createdAt: '2026-01-01T00:00:00Z' } },
      { id: 'mv-new', name: 'New Cut', trackId: 'track-1', midiTranscription: { filename: 'new.mid', model: 'medium', createdAt: '2026-06-01T00:00:00Z' } },
      { id: 'mv-other', name: 'Other', trackId: 'track-2', midiTranscription: { filename: 'other.mid', createdAt: '2026-07-01T00:00:00Z' } },
    ]);
    renderAt('track-1');
    const viz = await screen.findByTestId('midi-viz');
    // Newest transcription wins; other tracks' projects are ignored.
    expect(viz.getAttribute('data-url')).toBe('/data/music/new.mid');
    expect(viz.getAttribute('data-model')).toBe('medium');
    const link = screen.getByRole('link', { name: /from Music Video/ });
    expect(link.getAttribute('href')).toBe('/music-video/mv-new');
  });

  it('renders no MIDI section when no linked project has a transcription', async () => {
    listMusicVideoProjects.mockResolvedValue([
      { id: 'mv-1', name: 'No MIDI', trackId: 'track-1' },
    ]);
    renderAt('track-1');
    await screen.findByDisplayValue('Example Song');
    expect(screen.queryByTestId('midi-viz')).toBeNull();
    expect(screen.queryByText('MIDI transcription')).toBeNull();
  });
});

// #3264: the generator toggle used to live INSIDE the `persisted ?` gate, so a
// brand-new track rendered nothing at all where the generators belong and there
// was no way to learn the two modes existed until after the first save.
describe('<TracksManager> generator mode toggle', () => {
  beforeEach(() => {
    listTracks.mockResolvedValue([TRACK]);
    listAlbums.mockResolvedValue([]);
    listMusicVideoProjects.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const modeButton = (name) => screen.getByRole('button', { name });

  it('shows the toggle on an unsaved track, with a hint instead of a panel', async () => {
    renderAt('new');
    await screen.findByRole('group', { name: /generation mode/i });

    expect(modeButton('Audio model')).toBeInTheDocument();
    expect(modeButton('Chiptune score')).toBeInTheDocument();
    // Gating generation on a saved track is correct and stays — but it must
    // explain itself rather than render an empty region.
    expect(screen.getByText(/Save the track first, then generate with an audio model/i)).toBeInTheDocument();
    expect(screen.queryByTestId('gen-panel')).toBeNull();
    expect(screen.queryByTestId('chiptune-panel')).toBeNull();
  });

  it('switches mode before save and names the selected mode in the hint', async () => {
    renderAt('new');
    await screen.findByRole('group', { name: /generation mode/i });

    fireEvent.click(modeButton('Chiptune score'));

    expect(modeButton('Chiptune score')).toHaveAttribute('aria-pressed', 'true');
    expect(modeButton('Audio model')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/Save the track first, then generate a chiptune score/i)).toBeInTheDocument();
    expect(screen.queryByTestId('chiptune-panel')).toBeNull();
  });

  it('keeps a pre-save chiptune choice after Create navigates to the new track', async () => {
    const created = { id: 'track-new', title: 'Fresh Cut', renders: [] };
    createTrack.mockResolvedValue(created);

    render(
      <MemoryRouter initialEntries={['/music/tracks/new']}>
        <Routes>
          <Route path="/music/tracks/:id" element={<TracksManager />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('group', { name: /generation mode/i });

    fireEvent.click(modeButton('Chiptune score'));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fresh Cut' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // The hydration effect re-runs on the create → navigate transition; the
    // created track carries no `chiptuneScore`, so a naive re-derivation would
    // snap the editor back to "Audio model" the instant the track existed.
    expect(await screen.findByTestId('chiptune-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('gen-panel')).toBeNull();
    expect(modeButton('Chiptune score')).toHaveAttribute('aria-pressed', 'true');
  });

  it('still opens an existing scored track on the chiptune panel', async () => {
    listTracks.mockResolvedValue([{ ...TRACK, chiptuneScore: { tempo: 120 } }]);
    renderAt('track-1');

    expect(await screen.findByTestId('chiptune-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('gen-panel')).toBeNull();
  });

  it('opens an existing unscored track on the audio panel', async () => {
    renderAt('track-1');

    expect(await screen.findByTestId('gen-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('chiptune-panel')).toBeNull();
  });
});

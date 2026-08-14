import { useState } from 'react';
import { useNavigate } from 'react-router';
import MusicGenPanel from './MusicGenPanel';

export default function QuickMusicGenerator() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [lyrics, setLyrics] = useState('');

  return (
    <section className="max-w-4xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Generate a tune</h2>
        <p className="text-sm text-gray-400">Start with an idea. Artist and album are optional and can be added later.</p>
      </div>
      <label htmlFor="quick-music-title" className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-gray-500">Title (optional)</span>
        <input
          id="quick-music-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          placeholder="Derived from the prompt if left blank"
          className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white"
        />
      </label>
      <label htmlFor="quick-music-prompt" className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-gray-500">Music description</span>
        <textarea
          id="quick-music-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          maxLength={8000}
          placeholder="Warm instrumental soul, relaxed pocket, Rhodes piano, 92 BPM…"
          className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white"
        />
      </label>
      <label htmlFor="quick-music-lyrics" className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-gray-500">Lyrics (optional)</span>
        <textarea
          id="quick-music-lyrics"
          value={lyrics}
          onChange={(event) => setLyrics(event.target.value)}
          rows={6}
          maxLength={20000}
          placeholder={'[verse]\n…\n[chorus]\n…'}
          className="w-full rounded border border-port-border bg-port-bg px-3 py-2 font-mono text-sm text-white"
        />
      </label>
      <MusicGenPanel
        title={title}
        prompt={prompt}
        lyrics={lyrics}
        onGenerated={(track) => navigate(`/music/tracks/${encodeURIComponent(track.id)}`)}
      />
    </section>
  );
}

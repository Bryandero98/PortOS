/**
 * FableLoom index — branching narratives.
 *
 * Lists every loom (a branching-narrative story: episodes of scene graphs a
 * reader plays through by chatting intents) and creates new ones. The heavy
 * visual editor lives at /fableloom/:loomId/:episodeId.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Trash2, Waypoints } from 'lucide-react';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { timeAgo } from '../utils/formatters';
import {
  createLoom, deleteLoom, listLooms, listPipelineSeries, listUniverses,
} from '../services/api';

const emptyForm = () => ({ name: '', logline: '', premise: '', universeId: '', seriesId: '' });

const loomStats = (loom) => {
  const episodes = loom.episodes || [];
  const nodes = episodes.reduce((sum, e) => sum + (e.nodes?.length || 0), 0);
  const endings = episodes.reduce((sum, e) => sum + (e.nodes?.filter((n) => n.isEnding).length || 0), 0);
  return { episodes: episodes.length, nodes, endings };
};

export default function FableLoom() {
  const navigate = useNavigate();
  const [looms, setLooms] = useState(null);
  const [universes, setUniverses] = useState([]);
  const [series, setSeries] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [creating, setCreating] = useState(false);
  const del = useConfirmDelete();

  useEffect(() => {
    listLooms().then(setLooms).catch(() => setLooms([]));
    listUniverses({ silent: true }).then(setUniverses).catch(() => {});
    listPipelineSeries({ silent: true }).then(setSeries).catch(() => {});
  }, []);

  const universeName = (id) => universes.find((u) => u.id === id)?.name || null;
  const seriesName = (id) => series.find((s) => s.id === id)?.name || null;

  const handleCreate = async (event) => {
    event.preventDefault();
    if (!form.name.trim() || creating) return;
    setCreating(true);
    const loom = await createLoom({
      name: form.name.trim(),
      logline: form.logline,
      premise: form.premise,
      universeId: form.universeId || null,
      seriesId: form.seriesId || null,
    }).catch(() => null);
    setCreating(false);
    if (loom) navigate(`/fableloom/${loom.id}`);
  };

  const handleDelete = async (id) => {
    const ok = await deleteLoom(id).then(() => true).catch(() => false);
    if (ok) setLooms((prev) => prev.filter((l) => l.id !== id));
    del.cancelDelete();
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Waypoints size={20} className="text-port-accent" /> FableLoom
          </h1>
          <p className="text-sm text-port-text-muted mt-1">
            Branching narratives readers play through by chatting their intents — every episode is a
            graph of scenes with multiple endings.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-2 rounded bg-port-accent text-white text-sm"
        >
          <Plus size={15} /> New loom
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-port-text-muted mb-1" htmlFor="loom-name">Name</label>
              <input
                id="loom-name"
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. The Hollow Crown"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-port-text-muted mb-1" htmlFor="loom-logline">Logline</label>
              <input
                id="loom-logline"
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                value={form.logline}
                onChange={(e) => setForm((p) => ({ ...p, logline: e.target.value }))}
                placeholder="One sentence of premise"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-port-text-muted mb-1" htmlFor="loom-universe">Universe (canon + style for AI)</label>
              <select
                id="loom-universe"
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                value={form.universeId}
                onChange={(e) => setForm((p) => ({ ...p, universeId: e.target.value }))}
              >
                <option value="">No universe</option>
                {universes.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-port-text-muted mb-1" htmlFor="loom-series">Part of series (optional)</label>
              <select
                id="loom-series"
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                value={form.seriesId}
                onChange={(e) => setForm((p) => ({ ...p, seriesId: e.target.value }))}
              >
                <option value="">Standalone</option>
                {series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-port-text-muted mb-1" htmlFor="loom-premise">Premise</label>
            <textarea
              id="loom-premise"
              rows={3}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
              value={form.premise}
              onChange={(e) => setForm((p) => ({ ...p, premise: e.target.value }))}
              placeholder="The setup, stakes, and tone the AI should weave from"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={creating || !form.name.trim()}
              className="px-4 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create loom'}
            </button>
          </div>
        </form>
      )}

      {looms === null ? (
        <p className="text-sm text-port-text-muted">Loading…</p>
      ) : looms.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-port-border rounded-lg">
          <Waypoints size={32} className="mx-auto text-port-text-muted mb-3" />
          <p className="text-sm text-port-text-muted">
            No branching narratives yet. Create a loom, link a universe, and weave your first episode.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {looms.map((loom) => {
            const stats = loomStats(loom);
            return (
              <div
                key={loom.id}
                className="bg-port-card border border-port-border rounded-lg p-4 hover:border-port-accent transition-colors cursor-pointer"
                role="link"
                tabIndex={0}
                onClick={() => navigate(`/fableloom/${loom.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/fableloom/${loom.id}`); }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="font-medium truncate">{loom.name}</h2>
                    {loom.logline && <p className="text-xs text-port-text-muted mt-0.5 line-clamp-2">{loom.logline}</p>}
                  </div>
                  <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="none">
                    {del.isConfirming(loom.id) ? (
                      <ConfirmButtonPair
                        prompt="Delete?"
                        onConfirm={() => handleDelete(loom.id)}
                        onCancel={del.cancelDelete}
                      />
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete ${loom.name}`}
                        onClick={() => del.requestDelete(loom.id)}
                        className="text-port-text-muted hover:text-port-error p-1"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-3 text-xs text-port-text-muted flex-wrap">
                  <span>{stats.episodes} episode{stats.episodes === 1 ? '' : 's'}</span>
                  <span>{stats.nodes} scene{stats.nodes === 1 ? '' : 's'}</span>
                  <span>{stats.endings} ending{stats.endings === 1 ? '' : 's'}</span>
                  {universeName(loom.universeId) && (
                    <span className="px-1.5 py-0.5 rounded bg-port-accent/10 text-port-accent">
                      {universeName(loom.universeId)}
                    </span>
                  )}
                  {seriesName(loom.seriesId) && (
                    <span className="px-1.5 py-0.5 rounded bg-port-border/40">{seriesName(loom.seriesId)}</span>
                  )}
                  <span className="ml-auto">{timeAgo(loom.updatedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * FableLoom editor — the full-bleed visual workspace for one loom.
 *
 * URL is the source of truth: /fableloom/:loomId/:episodeId/:nodeId? — the
 * selected episode and scene are route params, the play drawer rides ?play=1.
 * Left: the scene-graph canvas. Right rail: the selected scene's editor, or
 * the structure/review panel when nothing is selected.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, BookOpenText, Loader2, Plus, Sparkles, Trash2, Waypoints } from 'lucide-react';
import toast from '../components/ui/Toast';
import Drawer from '../components/Drawer';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import LoomCanvas from '../components/fableloom/LoomCanvas';
import LoomNodeEditor from '../components/fableloom/LoomNodeEditor';
import LoomPlayPanel from '../components/fableloom/LoomPlayPanel';
import LoomValidationPanel from '../components/fableloom/LoomValidationPanel';
import {
  addLoomEpisode, addLoomNode, deleteLoomEpisode, getLoom, updateLoomEpisode,
  updateLoomNode, weaveLoomEpisode,
} from '../services/api';

export default function FableLoomStory() {
  const { loomId, episodeId, nodeId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loom, setLoom] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const playOpen = searchParams.get('play') === '1';

  useEffect(() => {
    setNotFound(false);
    getLoom(loomId).then(setLoom).catch(() => setNotFound(true));
  }, [loomId]);

  const episode = loom?.episodes.find((e) => e.id === episodeId) || null;
  const node = episode?.nodes.find((n) => n.id === nodeId) || null;

  const basePath = `/fableloom/${loomId}`;
  const episodePath = useCallback(
    (epId, nId) => `${basePath}/${epId}${nId ? `/${nId}` : ''}`,
    [basePath],
  );

  const onLoomUpdate = useCallback((next) => setLoom(next), []);

  const setPlayOpen = (open) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (open) next.set('play', '1');
      else next.delete('play');
      return next;
    }, { replace: true });
  };

  const handleAddEpisode = async () => {
    const updated = await addLoomEpisode(loomId, { title: `Episode ${(loom?.episodes.length || 0) + 1}` })
      .catch(() => null);
    if (updated) {
      setLoom(updated);
      const added = updated.episodes[updated.episodes.length - 1];
      navigate(episodePath(added.id));
      setSetupOpen(true);
    }
  };

  const handleAddNode = async () => {
    const updated = await addLoomNode(loomId, episode.id, { title: 'New scene' }).catch(() => null);
    if (updated) {
      setLoom(updated);
      const ep = updated.episodes.find((e) => e.id === episode.id);
      const added = ep?.nodes[ep.nodes.length - 1];
      if (added) navigate(episodePath(episode.id, added.id));
    }
  };

  const handleMoveNode = (movedNodeId, pos) => {
    // Optimistic: fold the new position into local state, persist silently.
    setLoom((prev) => ({
      ...prev,
      episodes: prev.episodes.map((e) => (e.id !== episode.id ? e : {
        ...e,
        nodes: e.nodes.map((n) => (n.id === movedNodeId ? { ...n, pos } : n)),
      })),
    }));
    updateLoomNode(loomId, episode.id, movedNodeId, { pos }, { silent: true })
      .then(onLoomUpdate)
      .catch(() => {});
  };

  if (notFound) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm text-port-text-muted">This loom no longer exists.</p>
        <Link to="/fableloom" className="text-port-accent text-sm hover:underline">Back to FableLoom</Link>
      </div>
    );
  }
  if (!loom) {
    return <div className="p-8 text-sm text-port-text-muted">Loading…</div>;
  }

  // Route normalization: no/stale episode id → first episode (or stay bare
  // when the loom has none yet).
  if (!episode && loom.episodes.length) {
    return <Navigate to={episodePath(loom.episodes[0].id)} replace />;
  }
  if (episodeId && !episode) {
    return <Navigate to={basePath} replace />;
  }

  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-port-border px-4 py-2.5 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Link to="/fableloom" className="text-port-text-muted hover:text-port-text" aria-label="Back to FableLoom">
            <ArrowLeft size={18} />
          </Link>
          <h1 className="font-semibold flex items-center gap-2 min-w-0">
            <Waypoints size={16} className="text-port-accent shrink-0" />
            <span className="truncate">{loom.name}</span>
          </h1>
          {episode && (
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={handleAddNode}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-port-border text-xs hover:border-port-accent"
              >
                <Plus size={13} /> Scene
              </button>
              <button
                type="button"
                onClick={() => setSetupOpen(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-port-border text-xs hover:border-port-accent"
              >
                <Sparkles size={13} /> Weave
              </button>
              <button
                type="button"
                onClick={() => setPlayOpen(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-port-accent text-white text-xs"
              >
                <BookOpenText size={13} /> Play
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {loom.episodes.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => navigate(episodePath(e.id))}
              className={`px-2.5 py-1 rounded-full text-xs border ${
                e.id === episodeId
                  ? 'border-port-accent text-port-accent bg-port-accent/10'
                  : 'border-port-border text-port-text-muted hover:border-port-accent'
              }`}
            >
              {e.number}. {e.title || 'Untitled'}
            </button>
          ))}
          <button
            type="button"
            onClick={handleAddEpisode}
            className="px-2.5 py-1 rounded-full text-xs border border-dashed border-port-border text-port-text-muted hover:border-port-accent hover:text-port-accent"
          >
            + Episode
          </button>
        </div>
      </header>

      {!episode ? (
        <div className="flex-1 grid place-items-center p-8 text-center">
          <div>
            <Waypoints size={32} className="mx-auto text-port-text-muted mb-3" />
            <p className="text-sm text-port-text-muted mb-3">
              No episodes yet — add one, then weave its scene graph with AI or build it by hand.
            </p>
            <button
              type="button"
              onClick={handleAddEpisode}
              className="px-3 py-2 rounded bg-port-accent text-white text-sm"
            >
              Add the first episode
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
          <section className="flex-1 min-h-[45vh] lg:min-h-0 relative">
            {episode.nodes.length ? (
              <LoomCanvas
                episode={episode}
                selectedNodeId={nodeId || null}
                onSelectNode={(id) => navigate(episodePath(episode.id, id) + (playOpen ? '?play=1' : ''))}
                onMoveNode={handleMoveNode}
              />
            ) : (
              <div className="h-full grid place-items-center p-8 text-center">
                <div>
                  <p className="text-sm text-port-text-muted mb-3">
                    This episode has no scenes yet.
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSetupOpen(true)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded bg-port-accent text-white text-sm"
                    >
                      <Sparkles size={14} /> Weave with AI
                    </button>
                    <button
                      type="button"
                      onClick={handleAddNode}
                      className="px-3 py-2 rounded border border-port-border text-sm hover:border-port-accent"
                    >
                      Add a scene by hand
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
          <aside className="lg:w-[380px] lg:shrink-0 border-t lg:border-t-0 lg:border-l border-port-border overflow-y-auto">
            {node ? (
              <LoomNodeEditor
                key={node.id}
                loom={loom}
                episode={episode}
                node={node}
                onLoomUpdate={onLoomUpdate}
                onClearSelection={() => navigate(episodePath(episode.id))}
                onMakeStart={node.id !== episode.startNodeId ? async () => {
                  const updated = await updateLoomEpisode(loomId, episode.id, { startNodeId: node.id })
                    .catch(() => null);
                  if (updated) setLoom(updated);
                } : null}
              />
            ) : (
              <LoomValidationPanel
                loom={loom}
                episode={episode}
                onSelectNode={(id) => navigate(episodePath(episode.id, id))}
              />
            )}
          </aside>
        </div>
      )}

      {episode && (
        <EpisodeSetupDrawer
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          loom={loom}
          episode={episode}
          onLoomUpdate={onLoomUpdate}
          onDeleted={() => {
            setSetupOpen(false);
            navigate(basePath);
          }}
        />
      )}

      {episode && (
        <Drawer open={playOpen} onClose={() => setPlayOpen(false)} title="Play" subtitle={loom.name} size="md" bodyClassName="p-0">
          <LoomPlayPanel loom={loom} episode={episode} />
        </Drawer>
      )}
    </div>
  );
}

/**
 * Episode setup drawer — title/synopsis (the weave inputs), the AI weave
 * controls, and episode deletion.
 */
function EpisodeSetupDrawer({ open, onClose, loom, episode, onLoomUpdate, onDeleted }) {
  const [form, setForm] = useState({ title: '', synopsis: '', guidance: '', nodeTarget: 12, endingTarget: 3 });
  const [weaving, setWeaving] = useState(false);
  const del = useConfirmDelete();
  const hasScenes = episode.nodes.length > 0;

  useEffect(() => {
    setForm((prev) => ({ ...prev, title: episode.title || '', synopsis: episode.synopsis || '' }));
  }, [episode.id, episode.title, episode.synopsis]);

  const saveMeta = (patch) => {
    updateLoomEpisode(loom.id, episode.id, patch, { silent: true })
      .then(onLoomUpdate)
      .catch((err) => toast.error(`Save failed: ${err.message}`));
  };

  const handleWeave = async () => {
    setWeaving(true);
    const result = await weaveLoomEpisode(loom.id, episode.id, {
      guidance: form.guidance,
      nodeTarget: Number(form.nodeTarget) || 12,
      endingTarget: Number(form.endingTarget) || 3,
      replace: hasScenes,
    }).catch(() => null);
    setWeaving(false);
    if (result?.loom) {
      onLoomUpdate(result.loom);
      toast.success('Episode woven');
      onClose();
    }
  };

  const handleDelete = async () => {
    const updated = await deleteLoomEpisode(loom.id, episode.id).catch(() => null);
    if (updated) {
      onLoomUpdate(updated);
      onDeleted();
    }
  };

  const field = 'w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
  const label = 'block text-xs font-medium text-port-text-muted mb-1';

  return (
    <Drawer open={open} onClose={onClose} title="Episode setup" subtitle={`${loom.name} — episode ${episode.number}`} size="sm">
      <div className="space-y-4">
        <div>
          <label className={label} htmlFor="loom-ep-title">Title</label>
          <input
            id="loom-ep-title"
            className={field}
            value={form.title}
            onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
            onBlur={() => saveMeta({ title: form.title })}
          />
        </div>
        <div>
          <label className={label} htmlFor="loom-ep-synopsis">Synopsis (feeds the weave)</label>
          <textarea
            id="loom-ep-synopsis"
            rows={4}
            className={field}
            placeholder="What this episode is about — setup, stakes, tone"
            value={form.synopsis}
            onChange={(e) => setForm((p) => ({ ...p, synopsis: e.target.value }))}
            onBlur={() => saveMeta({ synopsis: form.synopsis })}
          />
        </div>

        <div className="border-t border-port-border pt-4 space-y-3">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <Sparkles size={14} className="text-port-accent" /> Weave the scene graph
          </h4>
          <div>
            <label className={label} htmlFor="loom-ep-guidance">Guidance (optional)</label>
            <textarea
              id="loom-ep-guidance"
              rows={2}
              className={field}
              placeholder="e.g. lean into dread; one ending must be hopeful"
              value={form.guidance}
              onChange={(e) => setForm((p) => ({ ...p, guidance: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="loom-ep-nodes">Scenes (approx.)</label>
              <input
                id="loom-ep-nodes"
                type="number" min={3} max={60}
                className={field}
                value={form.nodeTarget}
                onChange={(e) => setForm((p) => ({ ...p, nodeTarget: e.target.value }))}
              />
            </div>
            <div>
              <label className={label} htmlFor="loom-ep-endings">Endings</label>
              <input
                id="loom-ep-endings"
                type="number" min={1} max={12}
                className={field}
                value={form.endingTarget}
                onChange={(e) => setForm((p) => ({ ...p, endingTarget: e.target.value }))}
              />
            </div>
          </div>
          {hasScenes && (
            <p className="text-xs text-port-warning">
              Weaving replaces this episode's {episode.nodes.length} existing scene{episode.nodes.length === 1 ? '' : 's'}.
            </p>
          )}
          <button
            type="button"
            onClick={handleWeave}
            disabled={weaving}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-60"
          >
            {weaving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {weaving ? 'Weaving…' : hasScenes ? 'Reweave episode' : 'Weave episode'}
          </button>
        </div>

        <div className="border-t border-port-border pt-4">
          {del.isConfirming(episode.id) ? (
            <ConfirmButtonPair
              prompt="Delete episode?"
              onConfirm={handleDelete}
              onCancel={del.cancelDelete}
            />
          ) : (
            <button
              type="button"
              onClick={() => del.requestDelete(episode.id)}
              className="flex items-center gap-1.5 text-xs text-port-text-muted hover:text-port-error"
            >
              <Trash2 size={13} /> Delete this episode
            </button>
          )}
        </div>
      </div>
    </Drawer>
  );
}

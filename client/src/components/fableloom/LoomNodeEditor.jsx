/**
 * FableLoom scene editor — the side panel for the selected node: title/prose,
 * ending flag + label, the intent-transition list, the scene image (prompt +
 * queued render via the shared image-gen lane), and the AI branch action.
 *
 * Fields save on blur (silent PATCH; the server returns the full loom, which
 * the parent folds into state). Transitions edit locally and save per-row on
 * blur through the same node PATCH.
 */

import { useEffect, useMemo, useState } from 'react';
import { GitBranch, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import MediaImage from '../MediaImage';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import {
  branchLoomNode, deleteLoomNode, generateImage, updateLoomNode,
} from '../../services/api';

const field = 'w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';
const label = 'block text-xs font-medium text-port-text-muted mb-1';

export default function LoomNodeEditor({ loom, episode, node, onLoomUpdate, onClearSelection, onMakeStart }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState('');
  const del = useConfirmDelete();

  // Sync from the record on scene switch ONLY (the parent keys this component
  // by node.id, so this is effectively the mount). Re-syncing on every server
  // echo would clobber typing in a sibling field while a blur-save round-trips.
  // Server-side additions that arrive mid-edit (AI branch, image attach) are
  // folded in explicitly where they happen.
  useEffect(() => {
    setForm({
      title: node.title || '',
      prose: node.prose || '',
      imagePrompt: node.imagePrompt || '',
      isEnding: !!node.isEnding,
      endingLabel: node.endingLabel || '',
      transitions: (node.transitions || []).map((t) => ({ ...t, triggersText: (t.triggers || []).join('; ') })),
    });
  }, [node.id]);

  const otherNodes = useMemo(
    () => episode.nodes.filter((n) => n.id !== node.id),
    [episode.nodes, node.id],
  );

  if (!form) return null;

  const patchNode = async (patch) => {
    const updated = await updateLoomNode(loom.id, episode.id, node.id, patch, { silent: true })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated) onLoomUpdate(updated);
    return updated;
  };

  const syncTransitionsFrom = (updatedLoom) => {
    const saved = updatedLoom?.episodes.find((e) => e.id === episode.id)
      ?.nodes.find((n) => n.id === node.id)?.transitions;
    if (!saved) return;
    setForm((prev) => ({
      ...prev,
      transitions: saved.map((t) => ({ ...t, triggersText: (t.triggers || []).join('; ') })),
    }));
  };

  const saveTransitions = async (transitions) => {
    const updated = await patchNode({
      transitions: transitions
        .filter((t) => t.targetNodeId)
        .map(({ id, targetNodeId, intent, triggersText, description }) => ({
          id, targetNodeId, intent,
          triggers: (triggersText || '').split(';').map((s) => s.trim()).filter(Boolean),
          description: description || '',
        })),
    });
    // Re-sync just the transition rows so server-minted ids replace the
    // locally-added rows' missing ones (id churn otherwise re-mints per save).
    syncTransitionsFrom(updated);
  };

  const setTransition = (index, patch) => {
    setForm((prev) => {
      const transitions = prev.transitions.map((t, i) => (i === index ? { ...t, ...patch } : t));
      return { ...prev, transitions };
    });
  };

  const removeTransition = (index) => {
    const transitions = form.transitions.filter((_, i) => i !== index);
    setForm((prev) => ({ ...prev, transitions }));
    saveTransitions(transitions);
  };

  const addTransition = () => {
    const target = otherNodes[0];
    if (!target) {
      toast.error('Add another scene first — a path needs somewhere to go');
      return;
    }
    setForm((prev) => ({
      ...prev,
      transitions: [...prev.transitions, { targetNodeId: target.id, intent: '', triggersText: '', description: '' }],
    }));
  };

  const handleBranch = async () => {
    setBusy('branch');
    const result = await branchLoomNode(loom.id, episode.id, node.id, { branchCount: 2 })
      .catch(() => null);
    setBusy('');
    if (result?.loom) {
      onLoomUpdate(result.loom);
      syncTransitionsFrom(result.loom);
      toast.success('New branches woven');
    }
  };

  const handleGenerateImage = async () => {
    const prompt = form.imagePrompt.trim();
    if (!prompt) {
      toast.error('Write an image prompt first');
      return;
    }
    setBusy('image');
    // Persist the prompt, then queue the render with the fableLoom destination
    // tag — the server-side completion hook files the finished image onto this
    // node even if the page unmounts mid-render.
    await patchNode({ imagePrompt: prompt });
    const queued = await generateImage({
      prompt: loom.styleNotes ? `${prompt}\n\nStyle: ${loom.styleNotes}` : prompt,
      fableLoom: { loomId: loom.id, episodeId: episode.id, nodeId: node.id },
    }).catch(() => null);
    setBusy('');
    if (queued) toast.success('Scene render queued — it will attach when it completes');
  };

  const handleDelete = async () => {
    const updated = await deleteLoomNode(loom.id, episode.id, node.id).catch(() => null);
    if (updated) {
      onLoomUpdate(updated);
      onClearSelection();
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Scene</h3>
          {onMakeStart && (
            <button
              type="button"
              onClick={onMakeStart}
              className="text-xs text-port-accent hover:underline"
            >
              Set as opening
            </button>
          )}
        </div>
        {del.isConfirming(node.id) ? (
          <ConfirmButtonPair prompt="Delete scene?" onConfirm={handleDelete} onCancel={del.cancelDelete} />
        ) : (
          <button
            type="button"
            onClick={() => del.requestDelete(node.id)}
            className="text-port-text-muted hover:text-port-error"
            aria-label="Delete scene"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      <div>
        <label className={label} htmlFor="loom-node-title">Title</label>
        <input
          id="loom-node-title"
          className={field}
          value={form.title}
          onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
          onBlur={() => patchNode({ title: form.title })}
        />
      </div>

      <div>
        <label className={label} htmlFor="loom-node-prose">Scene prose</label>
        <textarea
          id="loom-node-prose"
          rows={7}
          className={field}
          value={form.prose}
          onChange={(e) => setForm((p) => ({ ...p, prose: e.target.value }))}
          onBlur={() => patchNode({ prose: form.prose })}
        />
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm" htmlFor="loom-node-ending">
          <input
            id="loom-node-ending"
            type="checkbox"
            checked={form.isEnding}
            onChange={(e) => {
              setForm((p) => ({ ...p, isEnding: e.target.checked }));
              patchNode({ isEnding: e.target.checked });
            }}
          />
          This scene is an ending
        </label>
      </div>
      {form.isEnding && (
        <div>
          <label className={label} htmlFor="loom-node-ending-label">Ending name</label>
          <input
            id="loom-node-ending-label"
            className={field}
            placeholder="e.g. Treasure found"
            value={form.endingLabel}
            onChange={(e) => setForm((p) => ({ ...p, endingLabel: e.target.value }))}
            onBlur={() => patchNode({ endingLabel: form.endingLabel })}
          />
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-port-text-muted">Scene image</span>
          <button
            type="button"
            onClick={handleGenerateImage}
            disabled={busy === 'image'}
            className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
          >
            {busy === 'image' ? <Loader2 size={12} className="animate-spin" /> : <ImagePlus size={12} />}
            Generate
          </button>
        </div>
        <textarea
          rows={2}
          className={field}
          placeholder="Visual description for the image generator"
          aria-label="Image prompt"
          value={form.imagePrompt}
          onChange={(e) => setForm((p) => ({ ...p, imagePrompt: e.target.value }))}
          onBlur={() => patchNode({ imagePrompt: form.imagePrompt })}
        />
        {node.image && (
          <MediaImage
            src={`/data/images/${node.image}`}
            alt={form.title || 'Scene render'}
            className="mt-2 rounded max-w-full max-h-48 object-cover"
          />
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-port-text-muted">
            Paths out ({form.transitions.length})
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleBranch}
              disabled={busy === 'branch'}
              className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
            >
              {busy === 'branch' ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
              Branch with AI
            </button>
            <button type="button" onClick={addTransition} className="text-xs text-port-accent hover:underline">
              + Add path
            </button>
          </div>
        </div>
        {form.isEnding && form.transitions.length > 0 && (
          <p className="text-xs text-port-warning mb-2">Endings never fire their outgoing paths.</p>
        )}
        <div className="space-y-3">
          {form.transitions.map((tr, index) => (
            <div key={tr.id || `new-${index}`} className="border border-port-border rounded p-2 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  className={field}
                  placeholder='Reader intent, e.g. "search the wreck"'
                  aria-label="Intent"
                  value={tr.intent}
                  onChange={(e) => setTransition(index, { intent: e.target.value })}
                  onBlur={() => saveTransitions(form.transitions)}
                />
                <button
                  type="button"
                  onClick={() => removeTransition(index)}
                  className="text-port-text-muted hover:text-port-error shrink-0"
                  aria-label="Remove path"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <select
                className={field}
                aria-label="Leads to scene"
                value={tr.targetNodeId}
                onChange={(e) => {
                  setTransition(index, { targetNodeId: e.target.value });
                  saveTransitions(form.transitions.map((t, i) => (i === index ? { ...t, targetNodeId: e.target.value } : t)));
                }}
              >
                {otherNodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.title || 'Untitled scene'}</option>
                ))}
              </select>
              <input
                className={field}
                placeholder="Example phrasings, separated by ;"
                aria-label="Trigger phrasings"
                value={tr.triggersText}
                onChange={(e) => setTransition(index, { triggersText: e.target.value })}
                onBlur={() => saveTransitions(form.transitions)}
              />
            </div>
          ))}
          {!form.transitions.length && !form.isEnding && (
            <p className="text-xs text-port-warning">
              No paths out — mark this an ending or add a path.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

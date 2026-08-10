/**
 * Media Models — manage the model catalog + clean up cached weights.
 *
 * Two concerns share this page:
 *  1. Model catalog (registry): the image/video base models that can be picked
 *     in the gen forms. Built-in entries are read-only; user-added entries
 *     (installed from HuggingFace) are editable/removable. Adding a model here
 *     appends a `data/media-models.json` entry and hot-reloads the registry —
 *     no server restart (issue #2124).
 *  2. Cached weights: HF models live at HF's standard location
 *     (`~/.cache/huggingface/hub` unless HF_HOME is set). PortOS doesn't move or
 *     symlink them — it reads sizes for display and offers Delete to free disk.
 *     LoRAs sit in `data/loras/`.
 *
 * The two views are JOINED on the HF repo id: a catalog row whose weights are
 * on disk shows its size and a "Delete weights" action inline, so freeing disk
 * for a model no longer means scrolling to a second list to find the same model
 * again. The cached-weights section below only lists what the catalog does NOT
 * cover (text encoders, orphaned/removed repos).
 */

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Trash2, Image as ImageIcon, Film, Plus, Pencil, Lock, X, Check, HardDrive } from 'lucide-react';
import toast from '../components/ui/Toast';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import useConfirmDelete from '../hooks/useConfirmDelete';
import {
  listCachedModels,
  deleteCachedModel,
  deleteLora,
  listMediaModelRegistry,
  addMediaModelFromHf,
  patchCustomMediaModel,
  removeCustomMediaModel,
} from '../services/api';

const DESTRUCTIVE_BTN = 'px-3 py-1.5 text-xs bg-port-error/20 hover:bg-port-error/40 text-port-error rounded disabled:opacity-50 flex items-center gap-1';

/**
 * One arm-then-confirm destructive action. All four deletes on this page —
 * a catalog row's weights, a catalog row's registry entry, an orphaned cache
 * dir, a LoRA — are the same shape: a trigger that arms `confirmKey`, swapped
 * in place for the inline confirm pair. Keeping it in one component means the
 * confirm UX can't drift between them. `confirm` is a useConfirmDelete()
 * result, so only one action across the whole page is ever armed.
 */
function DeleteAction({
  confirm,
  confirmKey,
  prompt,
  ariaLabel,
  label,
  confirmText = 'Delete',
  busyText = 'Deleting…',
  busy = false,
  title,
  className = DESTRUCTIVE_BTN,
  icon: Icon = Trash2,
  onConfirm,
}) {
  if (confirm.isConfirming(confirmKey)) {
    return (
      <ConfirmButtonPair
        prompt={prompt}
        confirmText={confirmText}
        confirmIcon={Icon}
        busyText={busyText}
        busy={busy}
        ariaLabel={ariaLabel}
        onConfirm={() => confirm.confirmDelete(onConfirm)}
        onCancel={confirm.cancelDelete}
        className="shrink-0"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => confirm.requestDelete(confirmKey)}
      disabled={busy}
      title={title}
      className={className}
    >
      <Icon className="w-3 h-3" /> {busy ? busyText : label}
    </button>
  );
}

export default function MediaModels() {
  const [data, setData] = useState({ models: [], loras: [], hubDir: '', diskUsage: {} });
  const [registry, setRegistry] = useState({ video: [], image: [] });
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  // Add-from-HF form state
  const [hfUrl, setHfUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);

  // Inline edit state for a user-added entry
  const [editId, setEditId] = useState(null);
  const [editFields, setEditFields] = useState({ name: '', steps: '', guidance: '' });

  // One armed destructive action at a time, page-wide. Keys are namespaced
  // (`weights:` / `entry:` on a catalog row, `cache:` / `lora:` below) because
  // a catalog row carries TWO different deletes — its weights and its entry.
  const deleteConfirm = useConfirmDelete();

  const refresh = useCallback(() => {
    setError(null);
    // silent:true — the failure renders as the page's own full error state;
    // the default toast would duplicate it. Mirrors handleAddFromHf, whose
    // setAddError path is already silent.
    listCachedModels({ silent: true })
      .then(setData)
      .catch(err => setError(err?.message || 'Failed to load media models'));
    listMediaModelRegistry()
      .then(setRegistry)
      .catch(() => {}); // registry is secondary — cache view still renders on failure
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDeleteModel = async (id) => {
    setBusy(id);
    await deleteCachedModel(id, { silent: true })
      .then(() => {
        toast.success('Model deleted — will re-download on next use');
        setData((d) => ({ ...d, models: d.models.filter((m) => m.id !== id) }));
      })
      .catch((err) => toast.error(err.message || 'Delete failed'))
      .finally(() => setBusy(null));
  };

  const handleDeleteLora = async (filename) => {
    setBusy(filename);
    await deleteLora(filename, { silent: true })
      .then(() => {
        toast.success('LoRA deleted');
        setData((d) => ({ ...d, loras: d.loras.filter((l) => l.filename !== filename) }));
      })
      .catch((err) => toast.error(err.message || 'Delete failed'))
      .finally(() => setBusy(null));
  };

  const handleAddFromHf = async (e) => {
    e?.preventDefault?.();
    const url = hfUrl.trim();
    if (!url) return;
    setAdding(true);
    setAddError(null);
    await addMediaModelFromHf({ url, silent: true })
      .then((result) => {
        toast.success(`Added ${result?.entry?.name || 'model'} — download its weights from the gen form`);
        setHfUrl('');
        // The response carries the server-derived entry + kind, so update the
        // registry list locally instead of refetching (both round-trips).
        const kind = result?.kind === 'image' ? 'image' : 'video';
        const entry = { ...result.entry, kind, builtIn: false };
        setRegistry((r) => ({ ...r, [kind]: [...r[kind], entry] }));
      })
      .catch((err) => setAddError(err?.message || 'Failed to add model'))
      .finally(() => setAdding(false));
  };

  const startEdit = (m) => {
    setEditId(m.id);
    setEditFields({
      name: m.name ?? '',
      steps: m.steps ?? '',
      guidance: m.guidance ?? '',
    });
  };

  const cancelEdit = () => { setEditId(null); };

  const saveEdit = async (id) => {
    // Only send numeric fields the user actually filled in. A CLEARED input
    // must be OMITTED (not coerced): `Number('')` is 0 — a finite value that
    // trips the server's min(1) validator with a confusing 400 — so guard on
    // the raw string being non-blank BEFORE coercing, then also drop NaN from
    // non-numeric text. Omitted fields keep their prior value (PATCH is a
    // partial merge server-side).
    const parseField = (raw) => {
      if (typeof raw !== 'string' || raw.trim() === '') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const steps = parseField(editFields.steps);
    const guidance = parseField(editFields.guidance);
    const patch = { name: editFields.name.trim() };
    if (steps !== undefined) patch.steps = steps;
    if (guidance !== undefined) patch.guidance = guidance;
    setBusy(id);
    await patchCustomMediaModel(id, patch, { silent: true })
      .then((updated) => {
        toast.success('Model updated');
        setEditId(null);
        // Merge the returned fields into the matching registry row locally
        // instead of refetching the whole catalog + cache.
        const merge = (list) => list.map((m) => (m.id === id ? { ...m, ...updated } : m));
        setRegistry((r) => ({ video: merge(r.video), image: merge(r.image) }));
      })
      .catch((err) => toast.error(err.message || 'Update failed'))
      .finally(() => setBusy(null));
  };

  const handleRemoveCustom = async (id) => {
    setBusy(id);
    await removeCustomMediaModel(id, { silent: true })
      .then(() => {
        toast.success('Custom model removed');
        setRegistry((r) => ({
          video: r.video.filter((m) => m.id !== id),
          image: r.image.filter((m) => m.id !== id),
        }));
      })
      .catch((err) => toast.error(err.message || 'Remove failed'))
      .finally(() => setBusy(null));
  };

  if (error) {
    return (
      <div className="p-6 text-center">
        <AlertTriangle size={32} className="mx-auto text-port-warning mb-3" />
        <p className="text-gray-400 mb-3">Couldn't load media models: {error}</p>
        <button type="button" onClick={refresh} className="px-4 py-2 bg-port-card border border-port-border rounded-lg text-white hover:bg-port-bg">
          Retry
        </button>
      </div>
    );
  }

  // repo -> cached HF dir entry. Both sides key off `org/name`, so a catalog
  // row can report its own on-disk size and delete its own weights.
  const cachedByRepo = new Map((data.models || []).filter((m) => m.repo).map((m) => [m.repo, m]));
  const claimedRepos = new Set(
    [...registry.video, ...registry.image].map((m) => m.repo).filter(Boolean),
  );
  // Anything the catalog doesn't cover: text encoders, and repos whose catalog
  // entry was removed but whose (multi-GB) weights are still on disk.
  const unclaimedCached = (data.models || []).filter((m) => !claimedRepos.has(m.repo));

  const renderRegistryRow = (m) => {
    const isEditing = editId === m.id;
    const cached = m.repo ? cachedByRepo.get(m.repo) : null;
    const weightsBusy = cached && busy === cached.id;
    // Same key the row is rendered under: an id can repeat across kinds, and a
    // bare id would arm the image and video rows together.
    const rowKey = `${m.kind}-${m.id}`;
    return (
      <div key={rowKey} className="bg-port-bg border border-port-border rounded-lg p-3">
        {isEditing ? (
          <div className="space-y-2">
            <div>
              <label htmlFor={`edit-name-${m.id}`} className="block text-xs text-gray-400 mb-1">Name</label>
              <input
                id={`edit-name-${m.id}`}
                type="text"
                value={editFields.name}
                onChange={(e) => setEditFields((f) => ({ ...f, name: e.target.value }))}
                className="w-full px-2 py-1 text-sm bg-port-card border border-port-border rounded text-white"
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor={`edit-steps-${m.id}`} className="block text-xs text-gray-400 mb-1">Steps</label>
                <input
                  id={`edit-steps-${m.id}`}
                  type="number"
                  min="1"
                  max="200"
                  value={editFields.steps}
                  onChange={(e) => setEditFields((f) => ({ ...f, steps: e.target.value }))}
                  className="w-full px-2 py-1 text-sm bg-port-card border border-port-border rounded text-white"
                />
              </div>
              <div className="flex-1">
                <label htmlFor={`edit-guidance-${m.id}`} className="block text-xs text-gray-400 mb-1">Guidance</label>
                <input
                  id={`edit-guidance-${m.id}`}
                  type="number"
                  min="0"
                  max="30"
                  step="0.5"
                  value={editFields.guidance}
                  onChange={(e) => setEditFields((f) => ({ ...f, guidance: e.target.value }))}
                  className="w-full px-2 py-1 text-sm bg-port-card border border-port-border rounded text-white"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={cancelEdit} disabled={busy === m.id} className="px-3 py-1.5 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:bg-port-bg flex items-center gap-1">
                <X className="w-3 h-3" /> Cancel
              </button>
              <button type="button" onClick={() => saveEdit(m.id)} disabled={busy === m.id} className="px-3 py-1.5 text-xs bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded disabled:opacity-50 flex items-center gap-1">
                <Check className="w-3 h-3" /> {busy === m.id ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-white truncate flex items-center gap-2">
                {m.name}
                {m.builtIn && <Lock className="w-3 h-3 text-gray-500 shrink-0" title="Built-in catalog entry (name/steps are read-only)" />}
                {m.deprecated && <span className="text-[10px] px-1 rounded bg-port-warning/20 text-port-warning">legacy</span>}
                {cached && (
                  <span className="text-[10px] px-1 rounded bg-port-success/20 text-port-success shrink-0 flex items-center gap-1">
                    <HardDrive className="w-2.5 h-2.5" /> {cached.sizeHuman}
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500 truncate">
                {m.repo || m.id}
                {' · '}
                {m.runtime || m.runner || m.kind}
                {m.steps != null && ` · ${m.steps} steps`}
                {!cached && ' · weights not downloaded'}
              </div>
            </div>
            <div className="flex flex-wrap gap-1 shrink-0">
              {!m.builtIn && (
                <button type="button" onClick={() => startEdit(m)} disabled={busy === m.id} className="px-2 py-1.5 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:bg-port-bg disabled:opacity-50 flex items-center gap-1">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
              )}
              {/* Weights are deletable for BUILT-INS too — the lock only
                  covers the catalog entry, not the multi-GB download. */}
              {cached && (
                <DeleteAction
                  confirm={deleteConfirm}
                  confirmKey={`weights:${rowKey}`}
                  prompt={`Delete ${cached.sizeHuman} of weights?`}
                  ariaLabel={`Confirm deleting cached weights for ${m.name}`}
                  label="Delete weights"
                  title="Delete the downloaded weights (re-downloads on next use)"
                  busy={weightsBusy}
                  onConfirm={() => handleDeleteModel(cached.id)}
                />
              )}
              {!m.builtIn && (
                <DeleteAction
                  confirm={deleteConfirm}
                  confirmKey={`entry:${rowKey}`}
                  prompt="Remove from catalog?"
                  ariaLabel={`Confirm removing ${m.name} from the catalog`}
                  label="Remove"
                  confirmText="Remove"
                  busyText="Removing…"
                  title="Remove this entry from the model catalog"
                  icon={X}
                  className="px-2 py-1.5 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:bg-port-bg disabled:opacity-50 flex items-center gap-1"
                  busy={busy === m.id}
                  onConfirm={() => handleRemoveCustom(m.id)}
                />
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(data.diskUsage || {}).map(([key, value]) => (
          <div key={key} className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="text-xs text-gray-400 capitalize">{key}</div>
            <div className="text-lg font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {/* Model catalog — every pickable model, with its on-disk footprint and
          both of its deletes (weights / entry) on the row itself. Kept ABOVE
          the add form so managing existing models needs no scrolling. */}
      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <ImageIcon className="w-4 h-4" /> Model catalog
        </h2>
        {registry.video.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-gray-400 flex items-center gap-2"><Film className="w-3 h-3" /> Video models ({registry.video.length})</h3>
            <div className="space-y-2">{registry.video.map(renderRegistryRow)}</div>
          </div>
        )}
        {registry.image.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-gray-400 flex items-center gap-2"><ImageIcon className="w-3 h-3" /> Image models ({registry.image.length})</h3>
            <div className="space-y-2">{registry.image.map(renderRegistryRow)}</div>
          </div>
        )}
        {registry.video.length === 0 && registry.image.length === 0 && (
          <p className="text-xs text-gray-500">No models in the catalog yet — add one from HuggingFace below.</p>
        )}
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add a base model from HuggingFace
        </h2>
        <form onSubmit={handleAddFromHf} className="space-y-2">
          <label htmlFor="hf-model-url" className="block text-xs text-gray-400">
            HuggingFace repo (URL or <code>org/name</code>) — safetensors/MLX models only
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="hf-model-url"
              type="text"
              value={hfUrl}
              onChange={(e) => { setHfUrl(e.target.value); setAddError(null); }}
              placeholder="e.g. notapalindrome/ltx23-mlx-av-q4"
              className="flex-1 px-3 py-2 text-sm bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-600"
            />
            <button
              type="submit"
              disabled={adding || !hfUrl.trim()}
              className="px-4 py-2 text-sm bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded-lg disabled:opacity-50 flex items-center justify-center gap-1 shrink-0"
            >
              <Plus className="w-4 h-4" /> {adding ? 'Adding…' : 'Add Model'}
            </button>
          </div>
          {addError && (
            <p className="text-xs text-port-error flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {addError}
            </p>
          )}
          <p className="text-[11px] text-gray-600">
            GGUF-only, Wan, and HunyuanVideo repos are refused — no PortOS runtime can load them. For a GGUF LTX build, use the native MLX Q4 model instead.
          </p>
        </form>
      </div>

      {data.hubDir && (
        <p className="text-xs text-gray-500">
          HuggingFace cache: <code className="text-gray-400">{data.hubDir}</code>
        </p>
      )}

      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <HardDrive className="w-4 h-4" /> Other cached weights ({unclaimedCached.length})
        </h2>
        <p className="text-[11px] text-gray-600">
          Downloads with no catalog entry — text encoders, and models you removed from the catalog above. Weights for catalog models are deleted from their own row.
        </p>
        {unclaimedCached.length === 0 ? (
          <p className="text-xs text-gray-500">Nothing here — every cached download belongs to a model in the catalog above.</p>
        ) : (
          <div className="space-y-2">
            {unclaimedCached.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-port-bg border border-port-border rounded-lg p-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{m.label || m.repo}</div>
                  <div className="text-xs text-gray-500 truncate">{m.repo}</div>
                </div>
                <span className="text-sm text-gray-400 shrink-0">{m.sizeHuman}</span>
                <DeleteAction
                  confirm={deleteConfirm}
                  confirmKey={`cache:${m.id}`}
                  prompt={`Delete ${m.sizeHuman}?`}
                  ariaLabel={`Confirm deleting cached weights for ${m.label || m.repo}`}
                  label="Delete"
                  busy={busy === m.id}
                  onConfirm={() => handleDeleteModel(m.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-medium text-gray-300 flex items-center gap-2">
          <Film className="w-4 h-4" /> LoRAs ({data.loras.length})
        </h2>
        {data.loras.length === 0 ? (
          <p className="text-xs text-gray-500">
            Drop <code className="text-gray-400">.safetensors</code> LoRA files into <code className="text-gray-400">data/loras/</code> and they'll show up here for use in Image Gen.
          </p>
        ) : (
          <div className="space-y-2">
            {data.loras.map((l) => (
              <div key={l.filename} className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-port-bg border border-port-border rounded-lg p-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{l.name}</div>
                  <div className="text-xs text-gray-500 truncate">{l.filename}</div>
                </div>
                <span className="text-sm text-gray-400 shrink-0">{l.sizeHuman}</span>
                <DeleteAction
                  confirm={deleteConfirm}
                  confirmKey={`lora:${l.filename}`}
                  prompt={`Delete ${l.sizeHuman}?`}
                  ariaLabel={`Confirm deleting LoRA ${l.name}`}
                  label="Delete"
                  busy={busy === l.filename}
                  onConfirm={() => handleDeleteLora(l.filename)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

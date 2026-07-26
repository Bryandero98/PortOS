import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  createUniverse,
  deleteUniverse,
  getProviders,
  getSettings,
  getUniverse,
  listImageModels,
  listLorasFull,
  listUniverses,
  listWorldRuns,
  updateUniverse,
  WORLD_LOCKABLE_FIELDS,
  WORLD_STYLE_REFERENCES_MAX,
  ensureInfluences,
} from '../services/api';
import { deriveAvailableBackends, IMAGE_GEN_MODE } from '../lib/imageGenBackends';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings } from '../lib/pipelineImageDefaults';
import { sameJsonShape } from '../lib/sameJsonShape';
import { upsertByIdPrepend } from '../lib/upsertByIdPrepend';
import { mergeCanonByName } from '../lib/universeBuilderExpand';
import {
  TRUNK_BY_KIND,
  ensureDraftCategories,
  humanizeCategory,
  normalizeCategoryKey,
} from '../lib/universeBuilderShared';

export const createEmptyUniverseDraft = () => ({
  name: '',
  starterPrompt: '',
  logline: '',
  premise: '',
  styleNotes: '',
  categories: ensureDraftCategories(),
  compositeSheets: [],
  influences: { embrace: [], avoid: [] },
  styleReferences: [],
  locked: {},
  llm: { provider: null, model: null },
});

// Stable serialization of the fields the general Save action owns. Canon and
// styleReferences are excluded because targeted editors persist those
// arrays independently.
export const universeDraftSnapshot = (draft = {}) => JSON.stringify({
  name: (draft.name || '').trim(),
  starterPrompt: draft.starterPrompt || '',
  logline: draft.logline || '',
  premise: draft.premise || '',
  styleNotes: draft.styleNotes || '',
  categories: draft.categories || {},
  compositeSheets: draft.compositeSheets || [],
  influences: ensureInfluences(draft.influences),
  locked: draft.locked || {},
  llm: draft.llm || { provider: null, model: null },
});

const emptyPendingCanon = () => ({ characters: [], places: [], objects: [] });

/**
 * Owns the Universe Builder's editable draft and persistence contract.
 *
 * The hook deliberately centralizes the concurrency-sensitive pieces that
 * used to be interleaved with the route markup: the saved-draft baseline,
 * pending canon-addition ledger, selection hydration, keyed category writes,
 * and create/update/delete flows. LLM expansion/refinement and rendering stay
 * separate consumers of this contract.
 */
export default function useUniverseDraft({ selectedId, goToWorld }) {
  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [imageModels, setImageModels] = useState([]);
  const [availableLoras, setAvailableLoras] = useState([]);
  const [availableBackends, setAvailableBackends] = useState([]);
  const [defaultMode, setDefaultMode] = useState(null);
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [draft, setDraft] = useState(createEmptyUniverseDraft);
  const [runs, setRuns] = useState([]);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [canonDirty, setCanonDirty] = useState(false);

  const mountedRef = useRef(true);
  const draftRef = useRef(null);
  const savedDraftSnapshotRef = useRef(universeDraftSnapshot(createEmptyUniverseDraft()));
  const savedStyleSnapshotRef = useRef(ensureInfluences(createEmptyUniverseDraft().influences));
  const pendingCanonAdditionsRef = useRef(emptyPendingCanon());
  // Shared authoritative snapshot of styleReferences that both
  // persistStyleReference (add) and removeStyleReference (remove) read from
  // and write back to — draftRef only syncs after a React effect, which can
  // still be one render behind when two mutations fire before either PATCH
  // resolves; both would otherwise derive their replacement array from the
  // same stale list and the slower request's wholesale-replace PATCH would
  // silently undo the other's change. removeStyleReference additionally
  // serializes through styleReferenceQueueRef so back-to-back removals never
  // overlap. Reset whenever the selected universe changes (see the
  // selectedId-load effect below).
  const styleReferenceQueueRef = useRef(Promise.resolve());
  const styleReferenceSnapshotRef = useRef(null);

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const clearPendingCanonAdditions = useCallback(() => {
    pendingCanonAdditionsRef.current = emptyPendingCanon();
  }, []);

  const markDraftSaved = useCallback((snapshotSource) => {
    savedDraftSnapshotRef.current = universeDraftSnapshot(snapshotSource);
    savedStyleSnapshotRef.current = ensureInfluences(snapshotSource?.influences);
  }, []);

  // Mark only the style-guide fields as saved after an atomic reference-adopt
  // PATCH. Replacing the entire baseline here would incorrectly clear dirty
  // state for unrelated edits made while the vision request was in flight.
  const markStyleGuidanceSaved = useCallback((snapshotSource) => {
    const saved = JSON.parse(savedDraftSnapshotRef.current);
    saved.styleNotes = snapshotSource?.styleNotes || '';
    saved.influences = ensureInfluences(snapshotSource?.influences);
    savedDraftSnapshotRef.current = JSON.stringify(saved);
    savedStyleSnapshotRef.current = ensureInfluences(snapshotSource?.influences);
  }, []);

  const isDraftDirty = useCallback(
    () => savedDraftSnapshotRef.current !== universeDraftSnapshot(draftRef.current || draft),
    [draft],
  );

  const refresh = async () => {
    setLoading(true);
    const [list, providerData, models, loras, settings] = await Promise.all([
      listUniverses().catch(() => []),
      getProviders().catch(() => ({ providers: [] })),
      listImageModels().catch(() => []),
      listLorasFull().catch(() => []),
      getSettings().catch(() => ({})),
    ]);
    setWorlds(list);
    setProviders(providerData.providers || []);
    setActiveProviderId(providerData.activeProvider || null);
    setImageModels(models || []);
    setAvailableLoras(Array.isArray(loras) ? loras : []);
    const backends = deriveAvailableBackends(settings, { excludeExternal: true });
    setAvailableBackends(backends);
    const saved = settings?.imageGen?.mode;
    setDefaultMode(backends.find((backend) => backend.id === saved)?.id || backends[0]?.id || IMAGE_GEN_MODE.LOCAL);
    setImageCfg(readPipelineImageSettings(settings));
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    setPendingDeleteId(null);
    setCanonDirty(false);
    clearPendingCanonAdditions();
    // A new selection means any in-flight removeStyleReference chain belongs
    // to the PREVIOUS universe — reset so the next removal seeds its snapshot
    // from the freshly-hydrated draft instead of a stale/foreign one.
    styleReferenceQueueRef.current = Promise.resolve();
    styleReferenceSnapshotRef.current = null;
    if (!selectedId) {
      const empty = createEmptyUniverseDraft();
      setDraft(empty);
      markDraftSaved(empty);
      setRuns([]);
      return undefined;
    }
    let cancelled = false;
    Promise.all([
      getUniverse(selectedId).catch(() => null),
      listWorldRuns(selectedId).catch(() => []),
    ]).then(([universe, nextRuns]) => {
      if (cancelled) return;
      if (universe) {
        const hydrated = {
          ...universe,
          categories: ensureDraftCategories(universe.categories),
          compositeSheets: universe.compositeSheets || [],
          logline: universe.logline || '',
          premise: universe.premise || '',
          styleNotes: universe.styleNotes || '',
          influences: ensureInfluences(universe.influences),
          styleReferences: universe.styleReferences || [],
          locked: universe.locked || {},
          llm: universe.llm || { provider: null, model: null },
        };
        setDraft(hydrated);
        markDraftSaved(hydrated);
      }
      setRuns(nextRuns);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  const handleSave = async () => {
    if (!draft.name?.trim()) {
      toast.error('Name is required');
      return null;
    }
    setSaving(true);
    const basePayload = {
      name: draft.name.trim(),
      starterPrompt: draft.starterPrompt || '',
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      categories: draft.categories,
      compositeSheets: draft.compositeSheets || [],
      influences: ensureInfluences(draft.influences),
      locked: draft.locked || {},
      llm: draft.llm || {},
    };
    const needsCanonInPayload = !selectedId || canonDirty;
    let payload = basePayload;
    if (needsCanonInPayload) {
      if (selectedId) {
        const fresh = await getUniverse(selectedId, { silent: true }).catch(() => null);
        if (!fresh) {
          setSaving(false);
          toast.error('Save failed: could not fetch latest canon — please try again');
          return null;
        }
        const additions = pendingCanonAdditionsRef.current;
        payload = {
          ...basePayload,
          characters: mergeCanonByName(fresh.characters || [], additions.characters, 'character'),
          places: mergeCanonByName(fresh.places || [], additions.places, 'place'),
          objects: mergeCanonByName(fresh.objects || [], additions.objects, 'object'),
        };
      } else {
        payload = {
          ...basePayload,
          characters: draft.characters || [],
          places: draft.places || [],
          objects: draft.objects || [],
        };
      }
    }
    const result = selectedId
      ? await updateUniverse(selectedId, payload, { silent: true }).catch((error) => { toast.error(`Save failed: ${error.message}`); return null; })
      : await createUniverse(payload, { silent: true }).catch((error) => { toast.error(`Save failed: ${error.message}`); return null; });
    setSaving(false);
    if (!result) return null;
    if (needsCanonInPayload) {
      setCanonDirty(false);
      clearPendingCanonAdditions();
    }
    markDraftSaved(payload);
    toast.success(selectedId ? 'World updated' : 'World created');
    setWorlds((previous) => upsertByIdPrepend(previous, result));
    if (result.id !== selectedId) goToWorld(result.id);
    return result;
  };

  // Preflight for any server action that reads the PERSISTED universe (the LLM
  // actions, batch render): persist a dirty draft first, so the server operates
  // on what the user is looking at rather than the last-saved snapshot. Lives
  // here — beside the `isDraftDirty` / `handleSave` pair it is derived from —
  // so every consumer shares one definition of the contract.
  // Returns true when the draft is clean or the save succeeded; false (with
  // handleSave's own error toast already raised) when the save failed.
  const flushDraftIfDirty = async () => {
    if (!isDraftDirty()) return true;
    return !!(await handleSave());
  };

  const handleCreateNamed = async (rawName) => {
    const name = (rawName || '').trim();
    if (!name) {
      toast.error('Name is required');
      return;
    }
    if (!selectedId) {
      await handleSave();
      return;
    }
    setSaving(true);
    const result = await createUniverse({ ...createEmptyUniverseDraft(), name }, { silent: true })
      .catch((error) => { toast.error(`Create failed: ${error.message}`); return null; });
    setSaving(false);
    if (!result) return;
    toast.success('World created');
    setWorlds((previous) => upsertByIdPrepend(previous, result));
    goToWorld(result.id);
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    const deleted = await deleteUniverse(selectedId, { silent: true })
      .then(() => true)
      .catch((error) => { toast.error(`Delete failed: ${error.message}`); return false; });
    if (!deleted) return;
    setWorlds((previous) => previous.filter((universe) => universe.id !== selectedId));
    goToWorld(null);
    setDraft(createEmptyUniverseDraft());
    setPendingDeleteId(null);
    toast.success('World deleted');
  };

  const updateDraft = useCallback((patch) => setDraft((current) => ({ ...current, ...patch })), []);

  const persistStyleReference = useCallback(async ({ reference, proposed, adopt }) => {
    if (!selectedId || !reference) return false;
    const current = draftRef.current || draft;
    const capturedStyle = {
      styleNotes: current.styleNotes || '',
      influences: ensureInfluences(current.influences),
    };
    // Same authoritative snapshot removeStyleReference maintains — reading
    // draftRef here instead would miss a removal still settling and could
    // resurrect the item it just removed once this add's wholesale-replace
    // PATCH lands.
    const baseStyleReferences = styleReferenceSnapshotRef.current
      ?? (Array.isArray(current.styleReferences) ? current.styleReferences : []);
    if (baseStyleReferences.length >= WORLD_STYLE_REFERENCES_MAX) {
      toast.error(`A universe can hold up to ${WORLD_STYLE_REFERENCES_MAX} art references`);
      return false;
    }
    const styleReferences = [...baseStyleReferences, reference];
    const patch = {
      styleReferences,
      ...(adopt ? {
        styleNotes: proposed?.styleNotes || '',
        influences: ensureInfluences(proposed?.influences),
      } : {}),
    };
    const updated = await updateUniverse(selectedId, patch, { silent: true }).catch((error) => {
      toast.error(`Reference save failed: ${error.message}`);
      return null;
    });
    if (!updated) return false;
    // Keep the shared snapshot current so a later removeStyleReference call
    // builds its replacement array from a list that includes this addition —
    // otherwise a stale post-removal snapshot would silently drop it (codex
    // review finding).
    styleReferenceSnapshotRef.current = updated.styleReferences || [];
    if (adopt) markStyleGuidanceSaved(updated);
    setDraft((latest) => {
      const styleUnchangedDuringSave = latest.styleNotes === capturedStyle.styleNotes
        && sameJsonShape(ensureInfluences(latest.influences), capturedStyle.influences);
      return {
        ...latest,
        styleReferences: updated.styleReferences || [],
        updatedAt: updated.updatedAt,
        ...(adopt && styleUnchangedDuringSave ? {
          styleNotes: updated.styleNotes || '',
          influences: ensureInfluences(updated.influences),
        } : {}),
      };
    });
    setWorlds((previous) => upsertByIdPrepend(previous, updated));
    toast.success(adopt ? 'Art reference added and style guide updated' : 'Art reference added');
    return true;
  }, [draft, markStyleGuidanceSaved, selectedId]);

  const removeStyleReference = useCallback((referenceId) => {
    if (!selectedId) return Promise.resolve(false);
    // Chain onto the queue so a second removal clicked before the first PATCH
    // resolves derives its replacement array from the FIRST removal's actual
    // result (tracked in styleReferenceSnapshotRef), not from draftRef — which
    // only syncs one React effect later and would still show both items present.
    const task = styleReferenceQueueRef.current.then(async () => {
      const base = styleReferenceSnapshotRef.current
        ?? (draftRef.current || draft).styleReferences
        ?? [];
      const styleReferences = base.filter((item) => item.id !== referenceId);
      const updated = await updateUniverse(selectedId, { styleReferences }, { silent: true }).catch((error) => {
        toast.error(`Reference removal failed: ${error.message}`);
        return null;
      });
      if (!updated) return false;
      styleReferenceSnapshotRef.current = updated.styleReferences || [];
      setDraft((latest) => ({
        ...latest,
        styleReferences: updated.styleReferences || [],
        updatedAt: updated.updatedAt,
      }));
      setWorlds((previous) => upsertByIdPrepend(previous, updated));
      toast.success('Art reference removed');
      return true;
    });
    // Keep the queue alive even if this removal failed, so the NEXT removal
    // still runs (in its turn) rather than inheriting a rejected chain.
    styleReferenceQueueRef.current = task.catch(() => {});
    return task;
  }, [draft, selectedId]);

  const handleCanonChange = useCallback((updated) => {
    if (!updated) return;
    setDraft((current) => {
      if (canonDirty) {
        const additions = pendingCanonAdditionsRef.current;
        return {
          ...current,
          characters: mergeCanonByName(updated.characters || [], additions.characters, 'character'),
          places: mergeCanonByName(updated.places || [], additions.places, 'place'),
          objects: mergeCanonByName(updated.objects || [], additions.objects, 'object'),
          updatedAt: updated.updatedAt,
        };
      }
      return {
        ...current,
        characters: updated.characters,
        places: updated.places,
        objects: updated.objects,
        updatedAt: updated.updatedAt,
      };
    });
  }, [canonDirty]);

  const toggleLock = useCallback((field) => {
    if (!WORLD_LOCKABLE_FIELDS.includes(field)) return;
    setDraft((current) => {
      const nextLocked = { ...(current.locked || {}) };
      if (nextLocked[field]) delete nextLocked[field];
      else nextLocked[field] = true;
      const next = { ...current, locked: nextLocked };
      if (selectedId && next.name?.trim()) {
        updateUniverse(selectedId, { locked: nextLocked }, { silent: true })
          .catch((error) => toast.error(`Lock save failed: ${error.message}`));
      }
      return next;
    });
  }, [selectedId]);

  const updateCategory = useCallback((category, variations) => setDraft((current) => ({
    ...current,
    categories: {
      ...current.categories,
      [category]: { ...(current.categories?.[category] || {}), variations },
    },
  })), []);

  const assignBucketKind = async (bucket, targetKind) => {
    if (!TRUNK_BY_KIND[targetKind]) return;
    const latestDraft = draftRef.current || draft;
    const current = latestDraft.categories?.[bucket];
    if (!current) return;
    const nextBucket = { ...current, kind: targetKind };
    setDraft((value) => ({
      ...value,
      categories: {
        ...value.categories,
        [bucket]: { ...(value.categories?.[bucket] || current), kind: targetKind },
      },
    }));
    const trunk = TRUNK_BY_KIND[targetKind];
    if (!selectedId) {
      toast.success(`Tagged "${humanizeCategory(bucket)}" as ${trunk.label} — save to persist`);
      return;
    }
    const updated = await updateUniverse(
      selectedId,
      { categories: { [bucket]: nextBucket } },
      { silent: true },
    ).catch((error) => { toast.error(`Move failed: ${error.message}`); return null; });
    if (updated) {
      setWorlds((previous) => upsertByIdPrepend(previous, updated));
      toast.success(`Moved "${humanizeCategory(bucket)}" to ${trunk.label}`);
    }
  };

  const updateCompositeSheets = useCallback((sheets) => {
    setDraft((current) => ({ ...current, compositeSheets: sheets }));
  }, []);

  const addCategory = useCallback(() => {
    const key = normalizeCategoryKey(newCategoryName);
    if (!key) {
      toast.error('Use letters or numbers for the category name');
      return;
    }
    if (draft.categories?.[key]) {
      toast.error('Category already exists');
      return;
    }
    setDraft((current) => ({
      ...current,
      categories: { ...current.categories, [key]: { variations: [] } },
    }));
    setNewCategoryName('');
  }, [draft.categories, newCategoryName]);

  const removeCategory = useCallback((category) => setDraft((current) => {
    const categories = { ...current.categories };
    delete categories[category];
    return { ...current, categories: ensureDraftCategories(categories) };
  }), []);

  const providerLabel = useCallback(
    (id) => providers.find((provider) => provider.id === id)?.name || id || '—',
    [providers],
  );
  const providerModels = useMemo(() => {
    const provider = providers.find((item) => item.id === draft.llm?.provider)
      || providers.find((item) => item.id === activeProviderId);
    return provider?.models || [];
  }, [providers, activeProviderId, draft.llm?.provider]);
  const styleProbeDirty = !sameJsonShape(
    savedStyleSnapshotRef.current,
    ensureInfluences(draft.influences),
  );

  return {
    activeProviderId,
    addCategory,
    assignBucketKind,
    availableBackends,
    availableLoras,
    canonDirty,
    clearPendingCanonAdditions,
    defaultMode,
    draft,
    draftRef,
    flushDraftIfDirty,
    handleCanonChange,
    handleCreateNamed,
    handleDelete,
    handleSave,
    imageCfg,
    imageModels,
    isDraftDirty,
    loading,
    markDraftSaved,
    mountedRef,
    newCategoryName,
    pendingCanonAdditionsRef,
    pendingDeleteId,
    providerLabel,
    providerModels,
    providers,
    persistStyleReference,
    removeCategory,
    removeStyleReference,
    runs,
    saving,
    setCanonDirty,
    setDraft,
    setNewCategoryName,
    setPendingDeleteId,
    setRuns,
    setSaving,
    setWorlds,
    styleProbeDirty,
    toggleLock,
    universes,
    updateCategory,
    updateCompositeSheets,
    updateDraft,
  };
}

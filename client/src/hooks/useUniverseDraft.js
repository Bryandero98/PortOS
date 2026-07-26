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
  // Authoritative per-universe styleReferences state, keyed by universe id —
  // both persistStyleReference (add) and removeStyleReference (remove) read
  // their base array from and write their result back to the entry for the
  // universe they're actually mutating (`targetId`, captured at call time),
  // never a single shared slot. draftRef only syncs after a React effect,
  // which can still be one render behind when two mutations fire before
  // either PATCH resolves — reading a single shared "current" snapshot would
  // let the slower response's wholesale-replace PATCH undo the other
  // mutation's change, and — the reason this is keyed by id rather than a
  // single ref reset on every selection change — a switch away and back
  // (A → B → A) would otherwise permanently lose A's in-flight state instead
  // of correctly reconciling with it once it resolves. removeStyleReference
  // additionally serializes same-universe calls through the matching queue
  // entry so back-to-back removals on one universe never overlap; different
  // universes' queues are independent.
  //
  // Each entry is `{ references, guidance, epoch }`, where `epoch` counts the
  // MUTATION responses folded in so far. The epoch version-gates the other
  // writer — the hydration effect's `getUniverse` — against the last reordering
  // race: a mutation M issued before the user navigates away and back, and the
  // re-hydration GET G issued on the return. When M resolves first, G's body is
  // a PRE-mutation read, so letting it write would silently revert M
  // client-side. G captures the epoch when it is ISSUED and keeps its own body
  // only if no mutation landed while it was in flight.
  //
  // `guidance` is `{ styleNotes, influences }` when the mutation was an ADOPT —
  // that PATCH writes the style guide in the SAME request as the references, so
  // both halves are equally stale in a losing G. Overriding only the references
  // would let G revert the adopted guidance AND (via markDraftSaved) bank the
  // reverted values as the saved baseline, so the draft reads clean and the
  // next general Save pushes the stale guidance back server-side — a worse
  // outcome than the client-only revert this guard exists to stop. The override
  // is scoped to exactly the fields the winning PATCH wrote; every other field
  // still comes from G, which may legitimately be fresher (peer sync, canon).
  //
  // The guard is deliberately "a mutation always beats a concurrent GET", not a
  // monotonic issued-at sequence shared by all writers: G is issued AFTER M yet
  // reads state the server may not have written M into yet, so ordering by
  // issue time would make a late-resolving M lose to an earlier-issued G —
  // reintroducing the A → B → A loss fixed above. Keeping `epoch` in the same
  // record as the values it guards is what makes "the epoch moves whenever
  // those values do" structural rather than a convention writers must remember.
  const styleReferenceQueuesRef = useRef(new Map());
  const styleReferenceStatesRef = useRef(new Map());
  // Mirrors `selectedId` synchronously during render (not via a passive
  // effect, which runs one tick later and would leave a window where a
  // resolving PATCH still sees the OLD selection as current). Mutators
  // compare against this — not the `selectedId` closure value — to decide
  // whether their result should still touch the currently DISPLAYED draft;
  // the per-id snapshot/queue writes above always apply regardless, so a
  // save for a universe the user has navigated away from is never lost.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const clearPendingCanonAdditions = useCallback(() => {
    pendingCanonAdditionsRef.current = emptyPendingCanon();
  }, []);

  const styleReferenceState = useCallback(
    (id) => styleReferenceStatesRef.current.get(id) ?? { references: null, guidance: null, epoch: 0 },
    [],
  );

  // Record a mutation's confirmed values for `id`, bumping its epoch so any
  // hydration GET still in flight for that universe knows its body is stale.
  // `guidance` is null for a mutation that didn't write the style guide; the
  // previous entry's guidance carries forward so a later plain add/remove
  // doesn't drop an earlier adopt's confirmed values.
  const applyStyleReferenceMutation = useCallback((id, references, guidance = null) => {
    const previous = styleReferenceState(id);
    styleReferenceStatesRef.current.set(id, {
      references,
      guidance: guidance ?? previous.guidance,
      epoch: previous.epoch + 1,
    });
  }, [styleReferenceState]);

  // Fold a hydration GET's styleReferences into `id`'s state, unless a mutation
  // resolved while the GET was in flight (epoch moved) — in which case that
  // mutation's values stand. Returns the draft fields the winning writer owns,
  // to be spread LAST over the hydrated draft so they override the server read.
  const applyStyleReferenceHydration = useCallback((id, issuedEpoch, references) => {
    const state = styleReferenceState(id);
    if (state.epoch !== issuedEpoch) {
      return { styleReferences: state.references, ...(state.guidance || {}) };
    }
    // This GET won, so its body IS the new baseline — including the style
    // guide. Drop the stashed guidance: it describes an older PATCH the server
    // has since confirmed, so carrying it past this point would let a LATER
    // plain add/remove (which contributes no guidance of its own) overlay
    // those spent values over a genuinely newer server styleNotes/influences.
    styleReferenceStatesRef.current.set(id, { ...state, references, guidance: null });
    return { styleReferences: references };
  }, [styleReferenceState]);

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
    // No styleReference queue/snapshot reset needed here — both are keyed by
    // universe id (see styleReferenceQueuesRef/styleReferenceStatesRef
    // above), so switching away and back naturally finds each universe's own
    // state exactly as it left it.
    if (!selectedId) {
      const empty = createEmptyUniverseDraft();
      setDraft(empty);
      markDraftSaved(empty);
      setRuns([]);
      return undefined;
    }
    let cancelled = false;
    // Captured BEFORE the fetch is issued — see styleReferenceStatesRef.
    const issuedEpoch = styleReferenceState(selectedId).epoch;
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
          // Refresh this universe's styleReferences snapshot from the server on
          // every successful hydration — a stale map entry from an earlier
          // local mutation (or absence of one, on first visit) must not shadow
          // changes made while this universe wasn't selected (peer sync, the
          // image-delete purge route). The next add/remove needs this fresh
          // baseline, not a leftover cache (codex review finding) — except when
          // a mutation resolved while this GET was in flight, in which case
          // this spread overrides the fields THAT PATCH wrote with its newer
          // confirmed values (see styleReferenceStatesRef). Spread LAST so it
          // wins over the server read above; markDraftSaved then banks the
          // overridden values, not the stale ones.
          ...applyStyleReferenceHydration(selectedId, issuedEpoch, universe.styleReferences || []),
        };
        setDraft(hydrated);
        markDraftSaved(hydrated);
      }
      setRuns(nextRuns);
    });
    return () => { cancelled = true; };
  }, [selectedId, applyStyleReferenceHydration, styleReferenceState]);

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
    const targetId = selectedId;
    const current = draftRef.current || draft;
    const capturedStyle = {
      styleNotes: current.styleNotes || '',
      influences: ensureInfluences(current.influences),
    };
    // Per-universe snapshot removeStyleReference also reads/writes — reading
    // draftRef here instead would miss a removal still settling for the same
    // universe and could resurrect the item it just removed once this add's
    // wholesale-replace PATCH lands.
    const baseStyleReferences = styleReferenceState(targetId).references
      ?? (targetId === current.id && Array.isArray(current.styleReferences) ? current.styleReferences : []);
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
    const updated = await updateUniverse(targetId, patch, { silent: true }).catch((error) => {
      toast.error(`Reference save failed: ${error.message}`);
      return null;
    });
    if (!updated) return false;
    // Keep targetId's own snapshot current regardless of what's currently
    // selected — a later add/remove for targetId (including one after the
    // user navigates away and back) must build from this result, not a
    // pre-save list (codex review finding: an A→B→A round trip must not lose
    // A's in-flight save). The epoch bump invalidates any re-hydration GET for
    // targetId still in flight — see styleReferenceStatesRef. On the adopt
    // path the SAME PATCH wrote the style guide, so hand that over too or a
    // losing GET reverts the adopted guidance while the references survive.
    applyStyleReferenceMutation(targetId, updated.styleReferences || [], adopt ? {
      styleNotes: updated.styleNotes || '',
      influences: ensureInfluences(updated.influences),
    } : null);
    // But only touch the currently DISPLAYED draft if the user is still on
    // targetId — applying it otherwise would poison a DIFFERENT, now-selected
    // universe's state with targetId's references (codex review finding).
    // selectedIdRef mirrors selectedId synchronously during render (not via a
    // passive effect), so there is no timing window where a resolving PATCH
    // sees a stale "current selection".
    if (selectedIdRef.current === targetId) {
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
    }
    setWorlds((previous) => upsertByIdPrepend(previous, updated));
    toast.success(adopt ? 'Art reference added and style guide updated' : 'Art reference added');
    return true;
  }, [applyStyleReferenceMutation, draft, markStyleGuidanceSaved, selectedId, styleReferenceState]);

  const removeStyleReference = useCallback((referenceId) => {
    if (!selectedId) return Promise.resolve(false);
    const targetId = selectedId;
    const current = draftRef.current || draft;
    // Chain onto targetId's OWN queue (not a shared one) so two removals on
    // the SAME universe never overlap, while removals on a DIFFERENT
    // universe are unaffected — this task can be dequeued well after the user
    // has switched away from and even back to targetId, so it must resolve
    // its base from targetId's own tracked state, never from whatever
    // universe happens to be selected when its turn comes up.
    const queue = styleReferenceQueuesRef.current.get(targetId) ?? Promise.resolve();
    const task = queue.then(async () => {
      const base = styleReferenceState(targetId).references
        ?? (targetId === current.id && Array.isArray(current.styleReferences) ? current.styleReferences : []);
      const styleReferences = base.filter((item) => item.id !== referenceId);
      const updated = await updateUniverse(targetId, { styleReferences }, { silent: true }).catch((error) => {
        toast.error(`Reference removal failed: ${error.message}`);
        return null;
      });
      if (!updated) return false;
      // Keep targetId's own snapshot current regardless of what's currently
      // selected (codex review finding: an A→B→A round trip must not lose
      // A's in-flight removal). The epoch bump invalidates any re-hydration
      // GET for targetId still in flight — see styleReferenceStatesRef.
      applyStyleReferenceMutation(targetId, updated.styleReferences || []);
      // Only touch the currently DISPLAYED draft if the user is still on
      // targetId — selectedIdRef mirrors selectedId synchronously during
      // render, so there is no passive-effect timing window where a
      // resolving PATCH sees a stale "current selection" (codex review
      // finding).
      if (selectedIdRef.current === targetId) {
        setDraft((latest) => ({
          ...latest,
          styleReferences: updated.styleReferences || [],
          updatedAt: updated.updatedAt,
        }));
      }
      setWorlds((previous) => upsertByIdPrepend(previous, updated));
      toast.success('Art reference removed');
      return true;
    });
    // Keep targetId's queue alive even if this removal failed, so the NEXT
    // removal on the SAME universe still runs (in its turn) rather than
    // inheriting a rejected chain.
    styleReferenceQueuesRef.current.set(targetId, task.catch(() => {}));
    return task;
  }, [applyStyleReferenceMutation, draft, selectedId, styleReferenceState]);

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

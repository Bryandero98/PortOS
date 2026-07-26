import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  createUniverse: vi.fn(),
  deleteUniverse: vi.fn(),
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  getUniverse: vi.fn(),
  listImageModels: vi.fn(),
  listLorasFull: vi.fn(),
  listUniverses: vi.fn(),
  listWorldRuns: vi.fn(),
  updateUniverse: vi.fn(),
  WORLD_CATEGORY_KEY_MAX: 64,
  WORLD_CATEGORIES: ['characters', 'places', 'objects'],
  WORLD_LOCKABLE_FIELDS: ['starterPrompt', 'logline', 'premise', 'styleNotes'],
  WORLD_STYLE_REFERENCES_MAX: 20,
  ensureInfluences: (value) => ({
    embrace: Array.isArray(value?.embrace) ? value.embrace : [],
    avoid: Array.isArray(value?.avoid) ? value.avoid : [],
  }),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../services/api', () => apiMocks);
vi.mock('../components/ui/Toast', () => ({ default: toastMock }));

import useUniverseDraft from './useUniverseDraft.js';

const universe = {
  id: 'u1',
  name: 'Example Universe',
  starterPrompt: 'A test world',
  logline: 'Original logline',
  premise: 'Original premise',
  styleNotes: '',
  categories: { heroes: { kind: 'characters', variations: [] } },
  compositeSheets: [],
  influences: { embrace: ['ink'], avoid: [] },
  styleReferences: [],
  locked: {},
  llm: { provider: null, model: null },
  characters: [{ name: 'Stale Draft Character' }],
  places: [],
  objects: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listUniverses.mockResolvedValue([universe]);
  apiMocks.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
  apiMocks.listImageModels.mockResolvedValue([]);
  apiMocks.listLorasFull.mockResolvedValue([]);
  apiMocks.getSettings.mockResolvedValue({ imageGen: {} });
  apiMocks.getUniverse.mockResolvedValue(universe);
  apiMocks.listWorldRuns.mockResolvedValue([{ id: 'run-1' }]);
  apiMocks.updateUniverse.mockImplementation(async (id, payload) => ({ ...universe, id, ...payload }));
});

const renderDraft = () => {
  const goToWorld = vi.fn();
  const hook = renderHook(() => useUniverseDraft({ selectedId: 'u1', goToWorld }));
  return { ...hook, goToWorld };
};

describe('useUniverseDraft', () => {
  it('hydrates the selected universe and its run history', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));

    expect(result.current.draft.name).toBe('Example Universe');
    expect(result.current.runs).toEqual([{ id: 'run-1' }]);
    expect(result.current.isDraftDirty()).toBe(false);
  });

  it('saves general draft edits without replacing canon when canon is clean', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));

    act(() => result.current.updateDraft({ premise: 'Changed premise' }));
    expect(result.current.isDraftDirty()).toBe(true);
    await act(async () => { await result.current.handleSave(); });

    const payload = apiMocks.updateUniverse.mock.calls.at(-1)[1];
    expect(payload.premise).toBe('Changed premise');
    expect(payload).not.toHaveProperty('characters');
    expect(result.current.isDraftDirty()).toBe(false);
  });

  it('merges only pending canon additions onto a fresh server snapshot', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    apiMocks.getUniverse.mockResolvedValueOnce({
      ...universe,
      characters: [{ name: 'Server Character' }],
    });

    act(() => {
      result.current.setCanonDirty(true);
      result.current.pendingCanonAdditionsRef.current.characters = [{ name: 'New Character' }];
    });
    await act(async () => { await result.current.handleSave(); });

    const payload = apiMocks.updateUniverse.mock.calls.at(-1)[1];
    expect(payload.characters.map((entry) => entry.name)).toEqual([
      'Server Character',
      'New Character',
    ]);
    expect(payload.characters).not.toContainEqual({ name: 'Stale Draft Character' });
  });

  it('atomically adds a reference and adopted guidance without clearing unrelated dirty edits', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    act(() => result.current.updateDraft({ premise: 'Unsaved concurrent premise' }));

    const reference = {
      id: 'style-ref-1',
      title: 'Ink wash',
      prompt: 'Granular ink wash',
      imageRefs: ['reference.png'],
    };
    await act(async () => {
      await result.current.persistStyleReference({
        reference,
        proposed: {
          styleNotes: 'Tactile and muted',
          influences: { embrace: ['ink wash'], avoid: ['gloss'] },
        },
        adopt: true,
      });
    });

    const payload = apiMocks.updateUniverse.mock.calls.at(-1)[1];
    expect(payload).toEqual({
      styleReferences: [reference],
      styleNotes: 'Tactile and muted',
      influences: { embrace: ['ink wash'], avoid: ['gloss'] },
    });
    expect(result.current.draft).toMatchObject({
      premise: 'Unsaved concurrent premise',
      styleNotes: 'Tactile and muted',
      styleReferences: [reference],
    });
    expect(result.current.isDraftDirty()).toBe(true);
  });

  it('removes one style reference through its targeted patch', async () => {
    const reference = {
      id: 'style-ref-1',
      title: 'Ink wash',
      prompt: 'Granular ink wash',
      imageRefs: ['reference.png'],
    };
    apiMocks.getUniverse.mockResolvedValueOnce({ ...universe, styleReferences: [reference] });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([reference]));

    await act(async () => { await result.current.removeStyleReference(reference.id); });
    expect(apiMocks.updateUniverse.mock.calls.at(-1)[1]).toEqual({ styleReferences: [] });
    expect(result.current.draft.styleReferences).toEqual([]);
  });

  it('removes both references when two removals are triggered before either PATCH resolves', async () => {
    const refA = { id: 'style-ref-a', title: 'Ref A', prompt: 'moody', imageRefs: ['a.png'] };
    const refB = { id: 'style-ref-b', title: 'Ref B', prompt: 'bright', imageRefs: ['b.png'] };
    apiMocks.getUniverse.mockResolvedValueOnce({ ...universe, styleReferences: [refA, refB] });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refA, refB]));

    // Both removals derive their PATCH from the ARRAY THE SERVER LAST CONFIRMED
    // (the queue's tracked snapshot), not from a shared stale `draft` read at
    // call time — otherwise the second request's wholesale-replace payload
    // would still include refA (or refB) and silently restore it on resolve.
    await act(async () => {
      const first = result.current.removeStyleReference(refA.id);
      const second = result.current.removeStyleReference(refB.id);
      await Promise.all([first, second]);
    });

    expect(apiMocks.updateUniverse).toHaveBeenCalledTimes(2);
    expect(apiMocks.updateUniverse.mock.calls[0][1]).toEqual({ styleReferences: [refB] });
    expect(apiMocks.updateUniverse.mock.calls[1][1]).toEqual({ styleReferences: [] });
    expect(result.current.draft.styleReferences).toEqual([]);
  });

  it('keeps a reference added between two removals (remove A, add C, remove B)', async () => {
    const refA = { id: 'style-ref-a', title: 'Ref A', prompt: 'moody', imageRefs: ['a.png'] };
    const refB = { id: 'style-ref-b', title: 'Ref B', prompt: 'bright', imageRefs: ['b.png'] };
    const refC = { id: 'style-ref-c', title: 'Ref C', prompt: 'sunlit', imageRefs: ['c.png'] };
    apiMocks.getUniverse.mockResolvedValueOnce({ ...universe, styleReferences: [refA, refB] });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refA, refB]));

    await act(async () => { await result.current.removeStyleReference(refA.id); });
    expect(apiMocks.updateUniverse.mock.calls.at(-1)[1]).toEqual({ styleReferences: [refB] });

    await act(async () => {
      await result.current.persistStyleReference({ reference: refC, adopt: false });
    });
    // persistStyleReference must build its PATCH from the post-removal
    // snapshot (refB), not a stale pre-removal draft read.
    expect(apiMocks.updateUniverse.mock.calls.at(-1)[1]).toEqual({ styleReferences: [refB, refC] });

    await act(async () => { await result.current.removeStyleReference(refB.id); });
    // Regression: removeStyleReference's snapshot must have picked up refC
    // from the add above, or this PATCH would silently drop refC too.
    expect(apiMocks.updateUniverse.mock.calls.at(-1)[1]).toEqual({ styleReferences: [refC] });
    expect(result.current.draft.styleReferences).toEqual([refC]);
  });

  it('does not let a stale in-flight save for one universe overwrite a different, now-selected universe (codex review finding)', async () => {
    const universeTwo = {
      ...universe,
      id: 'u2',
      name: 'Second Universe',
      styleReferences: [{ id: 'style-ref-b2', title: 'Ref B2', prompt: 'b2', imageRefs: ['b2.png'] }],
    };
    apiMocks.getUniverse.mockImplementation(async (id) => (id === 'u2' ? universeTwo : universe));

    const goToWorld = vi.fn();
    const { result, rerender } = renderHook(
      ({ selectedId }) => useUniverseDraft({ selectedId, goToWorld }),
      { initialProps: { selectedId: 'u1' } },
    );
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));

    // Start a save for u1 but hold its PATCH response open — simulates the
    // user switching universes before this request resolves. Not wrapped in
    // act(): nothing synchronous before its first await touches React state.
    let resolveU1Save;
    apiMocks.updateUniverse.mockImplementationOnce(() => new Promise((resolve) => { resolveU1Save = resolve; }));
    const referenceForU1 = { id: 'style-ref-stale', title: 'Stale', prompt: 'stale', imageRefs: ['stale.png'] };
    const staleSave = result.current.persistStyleReference({ reference: referenceForU1, adopt: false });

    // Switch to u2 while u1's save is still pending.
    await act(async () => { rerender({ selectedId: 'u2' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u2'));
    expect(result.current.draft.styleReferences).toEqual(universeTwo.styleReferences);

    // Now let u1's stale save resolve.
    await act(async () => {
      resolveU1Save({ ...universe, styleReferences: [referenceForU1] });
      await staleSave;
    });

    // u2's displayed draft must be untouched by u1's stale, now-resolved response.
    expect(result.current.draft.id).toBe('u2');
    expect(result.current.draft.styleReferences).toEqual(universeTwo.styleReferences);

    // A subsequent removal on u2 must build its PATCH from u2's OWN
    // references, not from u1's stale snapshot.
    await act(async () => {
      await result.current.removeStyleReference(universeTwo.styleReferences[0].id);
    });
    expect(apiMocks.updateUniverse.mock.calls.at(-1)).toEqual(['u2', { styleReferences: [] }, { silent: true }]);
  });

  it('reconciles a save that resolves after an A -> B -> A round trip, instead of losing it (codex review finding)', async () => {
    const universeTwo = { ...universe, id: 'u2', name: 'Second Universe', styleReferences: [] };
    apiMocks.getUniverse.mockImplementation(async (id) => (id === 'u2' ? universeTwo : { ...universe, styleReferences: [] }));

    const goToWorld = vi.fn();
    const { result, rerender } = renderHook(
      ({ selectedId }) => useUniverseDraft({ selectedId, goToWorld }),
      { initialProps: { selectedId: 'u1' } },
    );
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));

    // Start a save on u1 and hold its response open.
    let resolveU1Save;
    apiMocks.updateUniverse.mockImplementationOnce(() => new Promise((resolve) => { resolveU1Save = resolve; }));
    const refX = { id: 'style-ref-x', title: 'Ref X', prompt: 'x', imageRefs: ['x.png'] };
    const pendingSave = result.current.persistStyleReference({ reference: refX, adopt: false });

    // u1 -> u2 -> u1, all before the save resolves.
    await act(async () => { rerender({ selectedId: 'u2' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u2'));
    await act(async () => { rerender({ selectedId: 'u1' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    // Re-hydration reflects the server's pre-save state (the save is still
    // in flight from the server's perspective too).
    expect(result.current.draft.styleReferences).toEqual([]);

    // Now the save resolves — since the user is back on u1, its result must
    // be reconciled into the displayed draft, not discarded.
    await act(async () => {
      resolveU1Save({ ...universe, styleReferences: [refX] });
      await pendingSave;
    });
    expect(result.current.draft.id).toBe('u1');
    expect(result.current.draft.styleReferences).toEqual([refX]);

    // The next mutation on u1 must build from the reconciled [refX], not from
    // a stale empty snapshot left over from before the round trip.
    await act(async () => { await result.current.removeStyleReference(refX.id); });
    expect(apiMocks.updateUniverse.mock.calls.at(-1)).toEqual(['u1', { styleReferences: [] }, { silent: true }]);
    expect(result.current.draft.styleReferences).toEqual([]);
  });

  it('refreshes the cached snapshot from the server on re-hydration, so an external change is not shadowed (codex review finding)', async () => {
    const universeTwo = { ...universe, id: 'u2', name: 'Second Universe', styleReferences: [] };
    const refOld = { id: 'style-ref-old', title: 'Old', prompt: 'old', imageRefs: ['old.png'] };
    const refExternal = { id: 'style-ref-external', title: 'External', prompt: 'external', imageRefs: ['external.png'] };
    // First visit to u1 returns refOld; a peer sync / image-delete purge then
    // changes u1's references server-side WHILE the user is on u2, so the
    // second fetch of u1 returns refExternal instead.
    let u1FetchCount = 0;
    apiMocks.getUniverse.mockImplementation(async (id) => {
      if (id === 'u2') return universeTwo;
      u1FetchCount += 1;
      return { ...universe, styleReferences: u1FetchCount === 1 ? [refOld] : [refExternal] };
    });

    const goToWorld = vi.fn();
    const { result, rerender } = renderHook(
      ({ selectedId }) => useUniverseDraft({ selectedId, goToWorld }),
      { initialProps: { selectedId: 'u1' } },
    );
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refOld]));

    await act(async () => { rerender({ selectedId: 'u2' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u2'));

    await act(async () => { rerender({ selectedId: 'u1' }); });
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refExternal]));

    // A removal now must target the freshly re-hydrated refExternal, not the
    // stale cached refOld from before the external change.
    await act(async () => { await result.current.removeStyleReference(refExternal.id); });
    expect(apiMocks.updateUniverse.mock.calls.at(-1)).toEqual(['u1', { styleReferences: [] }, { silent: true }]);
  });
});

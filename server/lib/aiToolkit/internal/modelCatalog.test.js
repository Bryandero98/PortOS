import { describe, it, expect } from 'vitest';
import { catalogContextWindow, modelCatalogUpdate, parseModelCatalog, toModelCatalog } from './modelCatalog.js';

describe('catalogContextWindow', () => {
  it('reads the spelling each vendor actually uses', () => {
    expect(catalogContextWindow({ context_length: 1_000_000 })).toBe(1_000_000);
    expect(catalogContextWindow({ max_model_len: 32_768 })).toBe(32_768);
    expect(catalogContextWindow({ max_context_length: 8192 })).toBe(8192);
    expect(catalogContextWindow({ n_ctx: 4096 })).toBe(4096);
    expect(catalogContextWindow({ context_window: 200_000 })).toBe(200_000);
  });

  it('takes the SMALLEST declared window when an entry reports several', () => {
    // OpenRouter's top-level `context_length` is the widest any upstream
    // offers; `top_provider.context_length` is what the default route serves.
    // Budgeting to the wider one builds a prompt the served route rejects.
    expect(catalogContextWindow({
      context_length: 1_000_000,
      top_provider: { context_length: 256_000 },
    })).toBe(256_000);
  });

  it('returns null — not zero — when the entry declares nothing', () => {
    // `null` is the "catalog didn't say" sentinel: the caller falls back to its
    // own heuristics for it, which is a different answer from a small window.
    expect(catalogContextWindow({ id: 'some/model' })).toBeNull();
    expect(catalogContextWindow('bare-string-entry')).toBeNull();
    expect(catalogContextWindow(null)).toBeNull();
    expect(catalogContextWindow({ context_length: 0 })).toBeNull();
    expect(catalogContextWindow({ context_length: -1 })).toBeNull();
    expect(catalogContextWindow({ context_length: 'lots' })).toBeNull();
  });

  it('ignores unrelated numbers nested elsewhere', () => {
    expect(catalogContextWindow({ id: 'm', pricing: { prompt: 3 }, architecture: { n_ctx: 99 } })).toBeNull();
  });
});

describe('parseModelCatalog', () => {
  it('pairs ids with the windows the catalog declared, and only those', () => {
    const { models, contextWindows } = parseModelCatalog([
      { id: 'stealth/ox-alpha', context_length: 1_000_000 },
      { id: 'openrouter/auto' },
      'bare-string-model',
    ], 'data');

    expect(models).toEqual(['stealth/ox-alpha', 'openrouter/auto', 'bare-string-model']);
    // A model the catalog said nothing about must be ABSENT, not zero — an
    // entry here would pin its budget to a made-up number.
    expect(contextWindows).toEqual({ 'stealth/ox-alpha': 1_000_000 });
  });

  it('accepts every id spelling servers mix', () => {
    const { models } = parseModelCatalog([{ id: 'a' }, { name: 'b' }, { model: 'c' }, 'd'], 'models');
    expect(models).toEqual(['a', 'b', 'c', 'd']);
  });

  it('throws on an entry with no usable id rather than persisting a broken catalog', () => {
    expect(() => parseModelCatalog([{ id: 'a' }, { size: 3 }], 'data'))
      .toThrow('Model list response had "data" entries with no usable model id');
  });

  it('yields an empty catalog for an empty list', () => {
    expect(parseModelCatalog([], 'data')).toEqual({ models: [], contextWindows: {} });
  });
});

describe('toModelCatalog', () => {
  it('lifts a plain id list into the catalog shape with no windows', () => {
    expect(toModelCatalog(['a', 'b'])).toEqual({ models: ['a', 'b'], contextWindows: {} });
  });

  it('passes a catalog through', () => {
    const catalog = { models: ['a'], contextWindows: { a: 128_000 } };
    expect(toModelCatalog(catalog)).toEqual(catalog);
  });

  it('is null for anything that is not a usable catalog', () => {
    expect(toModelCatalog(null)).toBeNull();
    expect(toModelCatalog(undefined)).toBeNull();
    expect(toModelCatalog({ models: 'nope' })).toBeNull();
  });
});

describe('modelCatalogUpdate', () => {
  const catalog = { models: ['a', 'b'], contextWindows: { a: 512_000 } };

  it('merges per model rather than replacing the map', () => {
    // A listing that declares a window for `a` says nothing about `b` — the
    // window `b` was learned from an earlier refresh has to survive, or it
    // drops back to the assumed 128K one refresh later.
    expect(modelCatalogUpdate(catalog, { a: 128_000, b: 1_000_000 }))
      .toEqual({ models: ['a', 'b'], modelContextWindows: { a: 512_000, b: 1_000_000 } });
  });

  it('prunes windows for models the provider no longer lists', () => {
    // That entry can never be selected again, and keeping it grows the record
    // by one dead key per model the upstream ever retired.
    expect(modelCatalogUpdate(catalog, { gone: 64_000 }).modelContextWindows)
      .toEqual({ a: 512_000 });
  });

  it('clears a stale map when every known model is delisted at once', () => {
    // `updateProvider` shallow-merges, so an OMITTED key leaves the stored map
    // in place — the prune would no-op in exactly the case it has the most to
    // remove, leaving windows keyed to models the provider no longer serves.
    const patch = modelCatalogUpdate({ models: ['fresh'], contextWindows: {} }, { gone: 64_000 });
    expect('modelContextWindows' in patch).toBe(true);
    expect(patch.modelContextWindows).toBeUndefined();
    // And the shallow merge a real update performs actually drops it.
    expect({ ...{ modelContextWindows: { gone: 64_000 } }, ...patch }.modelContextWindows).toBeUndefined();
  });

  it('omits the key entirely when nothing is known', () => {
    // Absent, not `{}` and not an explicit `undefined` — a record that never
    // learned a window has nothing to clear, so it stays clean.
    const patch = modelCatalogUpdate({ models: ['a'], contextWindows: {} });
    expect(patch).toEqual({ models: ['a'] });
    expect('modelContextWindows' in patch).toBe(false);
  });

  it('always writes the model list, including a legitimately empty one', () => {
    expect(modelCatalogUpdate({ models: [], contextWindows: {} })).toEqual({ models: [] });
  });

  it('copies the list so batched members never share one instance', () => {
    expect(modelCatalogUpdate(catalog).models).not.toBe(catalog.models);
  });
});

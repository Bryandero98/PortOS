import { describe, it, expect } from 'vitest';
import {
  buildMusicTasteRecipe,
  normalizeMusicTasteConfig,
  renderMusicTasteRecipePrompt,
  sanitizeMusicTasteRecipe,
} from './musicTasteRecipe.js';

const config = (overrides = {}) => ({
  source: 'digital-twin',
  window: 'month',
  anchorCount: 3,
  explorationPercent: 20,
  ...overrides,
});

const observed = {
  derivedAt: '2026-08-16T00:00:00.000Z',
  windows: {
    month: {
      listen: {
        topArtists: [
          { name: 'Example Artist A', count: 8 },
          { name: 'Example Artist B', count: 4 },
          { name: 'Example Artist C', count: 2 },
        ],
        topTracks: [
          { name: 'Example Track One', artist: 'Example Artist A', count: 6 },
          { name: 'Example Track Two', artist: 'Example Artist B', count: 3 },
        ],
      },
    },
  },
};

const sourceArgs = (overrides = {}) => ({
  commissionId: 'commission-example',
  config: config(),
  stated: { summary: 'Example stated preference', lastSessionAt: '2026-08-15T00:00:00.000Z' },
  observed,
  feedback: [],
  recentRuns: [],
  seed: 'stable-seed',
  ...overrides,
});

const combo = (recipe) => recipe.anchors.map((a) => `${a.kind}:${a.name}:${a.artist || ''}`).sort().join('|');

describe('normalizeMusicTasteConfig', () => {
  it('fills bounded defaults and treats blank engine/model ids as absent', () => {
    expect(normalizeMusicTasteConfig({ source: 'digital-twin', musicEngineId: '  ', musicModelId: 'example-model' }))
      .toEqual({
        source: 'digital-twin', window: 'month', anchorCount: 3, explorationPercent: 20,
        musicEngineId: null, musicModelId: 'example-model',
      });
  });

  it('rejects an unknown source instead of silently changing providers', () => {
    expect(normalizeMusicTasteConfig({ source: 'spotify-discovery' })).toBeNull();
  });
});

describe('buildMusicTasteRecipe', () => {
  it('is deterministic for the same bounded sources and seed', () => {
    const first = buildMusicTasteRecipe(sourceArgs());
    const second = buildMusicTasteRecipe(sourceArgs());
    expect(first).toEqual(second);
    expect(first.status).toBe('ready');
    expect(first.recipe.anchors).toHaveLength(3);
    expect(first.recipe.sourceHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('uses negative feedback to raise exploration while keeping the recipe bounded', () => {
    const result = buildMusicTasteRecipe(sourceArgs({
      config: config({ explorationPercent: 10 }),
      feedback: [{ rating: 'down', tags: ['more-experimental'] }],
    }));
    expect(result.recipe.explorationPercent).toBe(35);
    expect(result.recipe.explorationDirection).toBe('more-experimental');
    expect(result.recipe.anchors.every((anchor) => anchor.name.length <= 120)).toBe(true);
  });

  it('avoids the most recent exact anchor combination when another exists', () => {
    const first = buildMusicTasteRecipe(sourceArgs({ config: config({ anchorCount: 2, explorationPercent: 0 }) })).recipe;
    const next = buildMusicTasteRecipe(sourceArgs({
      config: config({ anchorCount: 2, explorationPercent: 0 }),
      recentRuns: [{ id: 'run-previous', tasteRecipe: first }],
    })).recipe;
    expect(combo(next)).not.toBe(combo(first));
  });

  it('returns an explicit unavailable result without observed anchors', () => {
    expect(buildMusicTasteRecipe(sourceArgs({ observed: null })))
      .toEqual({ status: 'unavailable', reason: 'taste-source-unavailable' });
  });
});

describe('music taste provenance', () => {
  it('sanitizes recipes to a bounded local shape', () => {
    const recipe = buildMusicTasteRecipe(sourceArgs()).recipe;
    const safe = sanitizeMusicTasteRecipe({ ...recipe, anchors: [...recipe.anchors, ...recipe.anchors, ...recipe.anchors] });
    expect(safe.anchors).toHaveLength(5);
    expect(safe).not.toHaveProperty('rawSources');
  });

  it('renders original-work constraints and never asks for imitation', () => {
    const recipe = buildMusicTasteRecipe(sourceArgs()).recipe;
    const prompt = renderMusicTasteRecipePrompt(recipe);
    expect(prompt).toContain('high-level inspiration only');
    expect(prompt).toContain('Create an original work');
    expect(prompt).toContain('do not reproduce source tracks');
  });
});

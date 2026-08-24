import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  client: { query: vi.fn() },
  createIngredient: vi.fn(),
  linkIngredientToSource: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  withTransaction: mocks.withTransaction,
}));

vi.mock('./catalogDB/ingredients.js', () => ({
  createIngredient: mocks.createIngredient,
}));

vi.mock('./catalogDB/refs.js', () => ({
  linkIngredientToSource: mocks.linkIngredientToSource,
}));

import { commitScrap } from './catalogDB/commit.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation((fn) => fn(mocks.client));
});

describe('commitScrap', () => {
  it('creates accepted ingredients and source links on one transaction client', async () => {
    mocks.createIngredient
      .mockResolvedValueOnce({ id: 'cat-chr-example', name: 'Example Character' })
      .mockResolvedValueOnce({ id: 'cat-plc-example', name: 'Example Place' });

    const created = await commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [
        { type: 'character', name: 'Example Character', payload: { role: 'lead' }, tags: ['hero'], span: { start: 1, end: 4 } },
        { type: 'place', name: 'Example Place' },
      ],
      embeds: [
        { embedding: [0.1, 0.2], model: 'example-model' },
        null,
      ],
    });

    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.createIngredient).toHaveBeenNthCalledWith(1, {
      type: 'character',
      name: 'Example Character',
      payload: { role: 'lead' },
      tags: ['hero'],
      embedding: [0.1, 0.2],
      embeddingModel: 'example-model',
    }, { client: mocks.client, source: 'extract' });
    expect(mocks.createIngredient).toHaveBeenNthCalledWith(2, {
      type: 'place',
      name: 'Example Place',
      payload: {},
      tags: [],
      embedding: null,
      embeddingModel: null,
    }, { client: mocks.client, source: 'extract' });
    expect(mocks.linkIngredientToSource).toHaveBeenNthCalledWith(
      1,
      'cat-chr-example',
      'cat-scrap-example',
      { start: 1, end: 4 },
      { client: mocks.client },
    );
    expect(mocks.linkIngredientToSource).toHaveBeenNthCalledWith(
      2,
      'cat-plc-example',
      'cat-scrap-example',
      null,
      { client: mocks.client },
    );
    expect(created).toEqual([
      { id: 'cat-chr-example', name: 'Example Character' },
      { id: 'cat-plc-example', name: 'Example Place' },
    ]);
  });

  it('does not swallow a failed transaction step', async () => {
    const failure = new Error('source link failed');
    mocks.createIngredient.mockResolvedValue({ id: 'cat-idea-example' });
    mocks.linkIngredientToSource.mockRejectedValue(failure);

    await expect(commitScrap({
      scrapId: 'cat-scrap-example',
      accepted: [{ type: 'idea', name: 'Example Idea' }],
    })).rejects.toBe(failure);
  });
});

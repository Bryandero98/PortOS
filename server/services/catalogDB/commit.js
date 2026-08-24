/**
 * Creative Ingredients Catalog — multi-row commit orchestration.
 *
 * Keeps transaction ownership inside the catalog data layer so HTTP callers
 * cannot accidentally persist only part of a scrap's accepted extraction.
 */

import { withTransaction } from '../../lib/db.js';
import { createIngredient } from './ingredients.js';
import { linkIngredientToSource } from './refs.js';

/**
 * Persist every accepted extraction draft and its source link atomically.
 * Embeddings are prepared by the caller before this DB-only transaction starts.
 */
export async function commitScrap({ scrapId, accepted = [], embeds = [] } = {}) {
  return withTransaction(async (client) => {
    const created = [];
    for (let i = 0; i < accepted.length; i++) {
      const draft = accepted[i];
      const embedding = embeds[i];
      const ingredient = await createIngredient({
        type: draft.type,
        name: draft.name,
        payload: draft.payload || {},
        tags: draft.tags || [],
        embedding: embedding?.embedding ?? null,
        embeddingModel: embedding?.model ?? null,
      }, { client, source: 'extract' });
      await linkIngredientToSource(ingredient.id, scrapId, draft.span || null, { client });
      created.push(ingredient);
    }
    return created;
  });
}

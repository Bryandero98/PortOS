/**
 * Offer `claude-sonnet-5` on a Claude CLI/TUI record that still lists only the
 * retired `claude-sonnet-4-6` sonnet tier.
 *
 * Migration 153 already made this swap, but ONLY for a `models` array matching
 * the prior seeded trio exactly — a user who had appended an id to the list (a
 * Fable tier, say) was classified as "customized" and skipped, and their record
 * kept the 4-6 tier while the shipped seed and their other Claude records moved
 * on. `claude` has no `models` subcommand, so nothing in the app can refresh
 * that record: the reviewer/task model pickers reading it offer the retired
 * sonnet and cannot offer the current one at all.
 *
 * ADDITIVE, deliberately — the opposite policy from 153/206 and from
 * `makeSeededProviderTierMigration`, because this one runs against lists the
 * user curated:
 *
 *   - `claude-sonnet-5` is INSERTED right after `claude-sonnet-4-6`, and the
 *     retired id is KEPT. `claude-sonnet-4-6` still resolves for the CLI, so
 *     dropping an id a user chose to list would remove a working pin; the defect
 *     is the new tier being absent, not the old one being present.
 *   - Tier pointers (`defaultModel`/`lightModel`/`mediumModel`/`heavyModel`) are
 *     left ALONE. They point at an id that still works, and a curated list is
 *     exactly where re-pointing would override a deliberate choice.
 *
 * Idempotent by the same condition either way: a record already listing
 * `claude-sonnet-5` is untouched, so this is a no-op on a seeded install (153/206
 * or a fresh `data.reference` seed already put it there) and on a second run.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const PROVIDERS_REL_PATH = 'data/providers.json';

// The four seeded Claude records and the sonnet id each one spells. The Bedrock
// pair uses the region-qualified form its own environment resolves — inserting a
// bare `claude-sonnet-5` there would offer an id that record cannot run.
const TARGETS = [
  { id: 'claude-code', retired: 'claude-sonnet-4-6', current: 'claude-sonnet-5' },
  { id: 'claude-code-tui', retired: 'claude-sonnet-4-6', current: 'claude-sonnet-5' },
  { id: 'claude-code-bedrock', retired: 'us.anthropic.claude-sonnet-4-6', current: 'us.anthropic.claude-sonnet-5' },
  { id: 'claude-code-tui-bedrock', retired: 'us.anthropic.claude-sonnet-4-6', current: 'us.anthropic.claude-sonnet-5' },
];

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds claude-sonnet-5 from data.reference)`);
      else if (doc.reason === 'unreadable') console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${doc.err.message})`);
      else console.log(`⚠️ ${PROVIDERS_REL_PATH}: unexpected shape, skipping`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const { config, providers, path: providersPath } = doc;
    const touched = [];

    for (const { id, retired, current } of TARGETS) {
      const provider = providers[id];
      if (!provider || !Array.isArray(provider.models)) continue;
      const at = provider.models.indexOf(retired);
      // Nothing to repair unless the retired id is listed AND the current one
      // isn't: an already-current record (seeded, or bumped by 153) is a no-op,
      // and a record that never listed the retired tier is not this bug.
      if (at === -1 || provider.models.includes(current)) continue;
      provider.models = [
        ...provider.models.slice(0, at + 1),
        current,
        ...provider.models.slice(at + 1),
      ];
      touched.push(id);
    }

    if (touched.length === 0) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: Claude sonnet tier already current — no change`);
      return { ok: true, reason: 'already-current', updated: 0 };
    }

    await writeJsonAtomic(providersPath, config);
    console.log(`📝 ${PROVIDERS_REL_PATH}: offered claude-sonnet-5 on ${touched.join(', ')}`);
    return { ok: true, reason: 'updated', updated: touched.length };
  },
};

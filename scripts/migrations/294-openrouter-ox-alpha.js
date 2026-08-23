/**
 * Add OpenRouter's `stealth/ox-alpha` to the shipped OpenRouter provider presets
 * and point their default tier at it.
 *
 * Migration 293 seeded the three OpenRouter records (`openrouter` API +
 * `opencode-openrouter` CLI/TUI wrappers) with only `openrouter/auto`, the
 * gateway's own router. Ox Alpha is a reasoning model aimed at long-horizon
 * agentic coding — 1M context, tool calling, and currently billed at zero on
 * OpenRouter — so it is the model a wrapper should reach for by default, while
 * `openrouter/auto` stays listed as the light tier.
 *
 * A wrapper's model list is otherwise refreshed from the gateway's `/models`
 * endpoint, which needs the sibling API record's key; seeding the id here means
 * an install can select Ox Alpha the moment it pastes a key, with no refresh
 * round-trip first.
 *
 * Conservative in the same way 292 is — see `isUntouchedSeed` below for what
 * that buys and what it deliberately leaves alone.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Later default changes
 * require a new migration.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const AUTO_MODEL = 'openrouter/auto';
// Namespaced for OpenCode this becomes `openrouter/stealth/ox-alpha` — the
// gateway's ids are already `vendor/model` and are never stored prefixed
// (`prefixOpencodeModel` in server/lib/providerModels.js).
const OX_ALPHA = 'stealth/ox-alpha';
const NEW_MODELS = [AUTO_MODEL, OX_ALPHA];

// Each row is the record's POST-migration tier block, so the table reads as the
// state it produces and stays row-for-row comparable with the two seed JSONs.
// Its keys double as the guard list — every tier a row names must still be
// parked on the router for that record to count as untouched.
//
// The API record carries four tier pointers; the CLI/TUI wrappers carry only
// `defaultModel`. `lightModel` stays on the router: Ox Alpha's reasoning is
// mandatory and defaults to max effort, which is the wrong trade for a cheap
// light-tier call even at zero cost.
const TARGETS = {
  openrouter: {
    defaultModel: OX_ALPHA, lightModel: AUTO_MODEL, mediumModel: OX_ALPHA, heavyModel: OX_ALPHA,
  },
  'opencode-openrouter': { defaultModel: OX_ALPHA },
  'opencode-openrouter-tui': { defaultModel: OX_ALPHA },
};

// Untouched means: exactly 293's one-model list, with every tier pointer still
// parked on it. Anything else — a list refreshed from the gateway, a trimmed
// list, a pinned model — is a user having spoken, and is left alone.
const isUntouchedSeed = (provider, tiers) =>
  Array.isArray(provider?.models)
  && provider.models.length === 1
  && provider.models[0] === AUTO_MODEL
  && tiers.every((tier) => provider[tier] === AUTO_MODEL);

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    // `readProvidersDoc` is deliberately silent — each caller owns its own log
    // copy, so an install that skips still says why on the boot line.
    if (!doc.ok) {
      const why = doc.reason === 'no-file'
        ? 'not present (a fresh install seeds OpenRouter from data.reference)'
        : `unreadable: ${doc.reason === 'unreadable' ? 'invalid JSON' : 'no providers map'}`;
      console.log(`📄 data/providers.json ${why} — skipping the OpenRouter ${OX_ALPHA} preset`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    let updated = 0;
    for (const [id, tierBlock] of Object.entries(TARGETS)) {
      const provider = doc.providers[id];
      if (!isUntouchedSeed(provider, Object.keys(tierBlock))) continue;
      provider.models = [...NEW_MODELS];
      Object.assign(provider, tierBlock);
      updated += 1;
    }

    if (!updated) return { ok: true, reason: 'already-current-or-custom', updated: 0 };
    await writeJsonAtomic(doc.path, doc.config);
    console.log(`📝 ${doc.path}: added ${OX_ALPHA} to ${updated} OpenRouter provider preset${updated === 1 ? '' : 's'}`);
    return { ok: true, reason: 'updated', updated };
  },
};

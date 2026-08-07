/**
 * Ship the Cursor Agent process-provider pair (CLI + TUI) to existing installs.
 *
 * Cursor's `cursor-agent` binary runs as a harness-capable coding agent, so PortOS
 * adds two process-provider entries: `cursor-cli` (headless one-shot via
 * `cursor-agent --print`, prompt on stdin) and `cursor-tui` (interactive PTY).
 * The CLI/TUI argv conventions live in server/lib/cursor.js — notably `--force`,
 * which clears cursor's workspace-trust gate (without it a headless run prints
 * "Workspace Trust Required" and exits) as well as auto-approving tool calls.
 *
 * Unlike Grok/Kimi/Antigravity, cursor needs no configured-default sentinel: its
 * `auto` router is a real model id, so it is stored as `defaultModel` and passed
 * through as a normal `--model auto`.
 *
 * `setup-data.js` merges *missing* provider entries from data.reference, but only
 * when an install re-runs setup. This migration delivers the providers on a plain
 * server restart too, and is the canonical path for deployed installs to pick them
 * up. Purely additive: brand-new ids, so there's no rename or pinned-id rewrite —
 * existing keys are left untouched (idempotent).
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Frozen here as the
 * historical record this migration installs; later default changes ride their own
 * migrations rather than mutating this one.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PROVIDERS_REL_PATH = 'data/providers.json';

// Curated from `cursor-agent models` (177 ids as of 2026-08-07). The full account
// catalog enumerates every reasoning tier AND a `-fast` priority-compute twin of
// each, which would make an unusable dropdown — this is the current-generation
// slice, one row per useful (family, tier). Any other id the account offers can
// still be typed into the provider's model list by hand.
const CURSOR_MODELS = [
  'auto',
  'composer-2.5',
  'claude-opus-5-high',
  'claude-opus-5-thinking-high',
  'claude-opus-5-thinking-xhigh',
  'claude-opus-5-thinking-max',
  'claude-sonnet-5-high',
  'claude-sonnet-5-thinking-high',
  'claude-sonnet-5-thinking-xhigh',
  'claude-fable-5-high',
  'claude-fable-5-thinking-high',
  'claude-opus-4-8-high',
  'claude-opus-4-8-thinking-high',
  'claude-4.6-sonnet-medium',
  'gpt-5.6-sol-high',
  'gpt-5.6-sol-xhigh',
  'gpt-5.6-luna-high',
  'gpt-5.6-terra-high',
  'gpt-5.5-high',
  'gpt-5.4-high',
  'gpt-5.4-mini-high',
  'gpt-5.3-codex',
  'gpt-5.3-codex-high',
  'gpt-5.3-codex-xhigh',
  'gpt-5.2-high',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
];

const CURSOR_TIERS = {
  defaultModel: 'auto',
  lightModel: 'composer-2.5',
  mediumModel: 'claude-sonnet-5-thinking-high',
  heavyModel: 'claude-opus-5-thinking-high',
};

const CURSOR_CLI = {
  id: 'cursor-cli',
  name: 'Cursor Agent CLI',
  type: 'cli',
  command: 'cursor-agent',
  args: ['--print', '--force'],
  models: CURSOR_MODELS,
  ...CURSOR_TIERS,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const CURSOR_TUI = {
  id: 'cursor-tui',
  name: 'Cursor Agent TUI',
  type: 'tui',
  command: 'cursor-agent',
  args: ['--force'],
  models: CURSOR_MODELS,
  ...CURSOR_TIERS,
  timeout: 600000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default {
  async up({ rootDir }) {
    const providersPath = join(rootDir, PROVIDERS_REL_PATH);
    const raw = await readFile(providersPath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds Cursor from data.reference)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${err.message})`);
      return;
    }

    if (!config || typeof config !== 'object' || !config.providers || typeof config.providers !== 'object') {
      console.log(`⚠️ ${PROVIDERS_REL_PATH}: unexpected shape, skipping`);
      return;
    }

    const providers = config.providers;
    let changed = false;

    for (const def of [CURSOR_CLI, CURSOR_TUI]) {
      if (!providers[def.id]) {
        // structuredClone fully detaches the shipped def (nested arrays/objects
        // included — CURSOR_MODELS is shared by both entries) so a later mutation
        // of the install can't corrupt it or leak across the two providers.
        providers[def.id] = structuredClone(def);
        changed = true;
        console.log(`📝 ${PROVIDERS_REL_PATH}: added ${def.id} provider`);
      }
    }

    if (changed) {
      await writeFile(providersPath, `${JSON.stringify(config, null, 2)}\n`);
    } else {
      console.log(`✅ ${PROVIDERS_REL_PATH}: Cursor providers already present — no change`);
    }
  },
};

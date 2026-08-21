/**
 * Mark the Claude-Ollama auth token as a secret environment variable.
 *
 * The token is part of the shipped process credential for both Claude-Ollama
 * variants, but older seed records left it out of `secretEnvVars`. That made
 * an explicitly blank token indistinguishable from an intentionally blank
 * ambient override in the provider card. This migration updates only the
 * shipped provider ids and preserves every other provider setting.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const PROVIDER_IDS = ['claude-ollama', 'claude-ollama-tui'];
const AUTH_ENV_VAR = 'ANTHROPIC_AUTH_TOKEN';

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) return { ok: false, reason: doc.reason, updated: 0 };

    let updated = 0;
    for (const id of PROVIDER_IDS) {
      const provider = doc.providers[id];
      if (!provider || !Object.hasOwn(provider.envVars || {}, AUTH_ENV_VAR)) continue;
      const secretEnvVars = Array.isArray(provider.secretEnvVars) ? provider.secretEnvVars : [];
      if (secretEnvVars.includes(AUTH_ENV_VAR)) continue;
      provider.secretEnvVars = [...secretEnvVars, AUTH_ENV_VAR];
      updated++;
    }

    if (updated === 0) {
      console.log(`✅ ${doc.path}: Claude-Ollama auth token already marked secret — no change`);
      return { ok: true, reason: 'already-current', updated: 0 };
    }

    await writeJsonAtomic(doc.path, doc.config);
    console.log(`📝 ${doc.path}: marked Claude-Ollama auth token secret (${updated} provider${updated === 1 ? '' : 's'})`);
    return { ok: true, reason: 'updated', updated };
  },
};

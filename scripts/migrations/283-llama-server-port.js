/**
 * Move the shipped llama-server endpoint off common port 8080.
 *
 * Port 8080 is frequently occupied by IPFS, Tomcat, local dashboards, and
 * other developer services. The managed llama-server now uses PortOS's
 * reserved extension port, 5568. Only the exact provider configuration shipped
 * by migration 280 is rewritten; a user who chose another endpoint keeps it.
 */

import { readProvidersDoc, writeJsonAtomic } from './_lib.js';

const OLD_ENDPOINT = 'http://127.0.0.1:8080/v1';
const NEW_ENDPOINT = 'http://127.0.0.1:5568/v1';
const PROVIDER_ID = 'opencode-llama-tui';

const storedLlamaConfig = (provider) => {
  const raw = provider?.envVars?.OPENCODE_CONFIG_CONTENT;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export default {
  async up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) return { ok: false, reason: doc.reason, updated: 0 };

    const provider = doc.providers[PROVIDER_ID];
    if (!provider || provider.endpoint !== OLD_ENDPOINT) {
      return { ok: true, reason: 'already-current-or-custom', updated: 0 };
    }

    const config = storedLlamaConfig(provider);
    // An unparsable or differently pointed OpenCode config is user-owned. Do
    // not make the displayed endpoint disagree with the config that actually
    // controls the spawned CLI.
    const configuredBaseUrl = config?.provider?.llama?.options?.baseURL;
    if (config === undefined || (configuredBaseUrl && configuredBaseUrl !== OLD_ENDPOINT)) {
      return { ok: true, reason: 'custom-config', updated: 0 };
    }

    provider.endpoint = NEW_ENDPOINT;
    if (configuredBaseUrl === OLD_ENDPOINT) {
      config.provider.llama.options.baseURL = NEW_ENDPOINT;
      provider.envVars = {
        ...provider.envVars,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      };
    }

    await writeJsonAtomic(doc.path, doc.config);
    console.log(`📝 ${doc.path}: moved ${PROVIDER_ID} from ${OLD_ENDPOINT} to ${NEW_ENDPOINT}`);
    return { ok: true, reason: 'updated', updated: 1 };
  },
};

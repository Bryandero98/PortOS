/**
 * Ship disabled OrcaRouter API and OpenCode presets to existing installs.
 *
 * OrcaRouter is an OpenAI-compatible gateway. The API provider owns the key;
 * the OpenCode wrappers keep their static config keyless and resolve the
 * sibling API key only when spawning or refreshing models. This migration is
 * additive and never contacts the gateway or changes the active provider.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. Later default changes
 * require a new migration.
 */

import { makeProviderSeedMigration } from './_lib.js';

const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"orcarouter":{"npm":"@ai-sdk/openai-compatible","name":"OrcaRouter","options":{"baseURL":"https://api.orcarouter.ai/v1"}}}}';

const ORCAROUTER_API = {
  id: 'orcarouter',
  name: 'OrcaRouter',
  type: 'api',
  endpoint: 'https://api.orcarouter.ai/v1',
  apiKey: '',
  models: ['orcarouter/auto'],
  defaultModel: 'orcarouter/auto',
  lightModel: 'orcarouter/auto',
  mediumModel: 'orcarouter/auto',
  heavyModel: 'orcarouter/auto',
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

const OPENCODE_ORCAROUTER_CLI = {
  id: 'opencode-orcarouter',
  name: 'OpenCode OrcaRouter',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  endpoint: 'https://api.orcarouter.ai/v1',
  models: ['orcarouter/auto'],
  defaultModel: 'orcarouter/auto',
  orcarouterBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  headlessArgs: [],
};

const OPENCODE_ORCAROUTER_TUI = {
  id: 'opencode-orcarouter-tui',
  name: 'OpenCode OrcaRouter TUI',
  type: 'tui',
  command: 'opencode',
  args: [],
  endpoint: 'https://api.orcarouter.ai/v1',
  models: ['orcarouter/auto'],
  defaultModel: 'orcarouter/auto',
  orcarouterBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'OrcaRouter',
  defs: [ORCAROUTER_API, OPENCODE_ORCAROUTER_CLI, OPENCODE_ORCAROUTER_TUI],
});

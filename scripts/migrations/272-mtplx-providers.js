/**
 * Ship disabled MTPLX provider presets to existing installs.
 *
 * MTPLX is an independently managed Apple Silicon runtime for Qwen native
 * multi-token prediction (MTP). It is not an Ollama model format, so PortOS
 * keeps the existing Ollama Qwen path intact and offers MTPLX through its
 * documented local OpenAI-compatible endpoint instead. The API preset serves
 * ordinary text tasks; the two OpenCode presets provide the file-writing CLI
 * and attachable TUI harnesses for CoS agent tasks.
 *
 * This migration deliberately does not install MTPLX, download a model, start a
 * daemon, tune a runtime, or contact an endpoint. All three providers are
 * disabled by default. An install that already owns one of these ids is left
 * untouched, preserving refreshed models and local endpoint edits.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. These frozen literals
 * are the historical upgrade payload; later default changes require a new
 * migration rather than rewriting this record.
 */

import { makeProviderSeedMigration } from './_lib.js';

const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"mtplx":{"npm":"@ai-sdk/openai-compatible","name":"MTPLX (local MTP)","options":{"baseURL":"http://127.0.0.1:8000/v1"}}}}';

const MTPLX_API = {
  id: 'mtplx',
  name: 'MTPLX (local MTP)',
  type: 'api',
  endpoint: 'http://127.0.0.1:8000/v1',
  apiKey: '',
  models: ['mtplx'],
  defaultModel: 'mtplx',
  timeout: 300000,
  enabled: false,
  envVars: {},
};

const OPENCODE_MTPLX_CLI = {
  id: 'opencode-mtplx',
  name: 'OpenCode MTPLX (local MTP)',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  endpoint: 'http://127.0.0.1:8000/v1',
  models: ['mtplx'],
  defaultModel: 'mtplx',
  mtplxBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  headlessArgs: [],
};

const OPENCODE_MTPLX_TUI = {
  id: 'opencode-mtplx-tui',
  name: 'OpenCode MTPLX TUI (local MTP)',
  type: 'tui',
  command: 'opencode',
  args: [],
  endpoint: 'http://127.0.0.1:8000/v1',
  models: ['mtplx'],
  defaultModel: 'mtplx',
  mtplxBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'MTPLX',
  defs: [MTPLX_API, OPENCODE_MTPLX_CLI, OPENCODE_MTPLX_TUI],
});

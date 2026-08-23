/**
 * Ship disabled OpenCode SGLang provider presets to existing installs.
 *
 * SGLang's official `lmsysorg/sglang:qwen38-27b` image serves Qwen3.8-27B on a
 * Hopper or Blackwell card — the third CUDA path PortOS knows about, alongside
 * the Ampere-only vLLM container (migration 285) and the Apple Silicon MTPLX /
 * llama-server pair. It is an OpenAI-compatible daemon, so it is fronted the
 * same way: a headless `cli` twin and the attachable `tui` that CoS agent tasks
 * actually run in.
 *
 * No API preset, for the same reason as vLLM: a text-only record adds a third
 * place to configure for no capability the two coding harnesses lack. The
 * Anthropic `/v1/messages` pair (Claude Code without LiteLLM) is #4777, which
 * carries its own env-var contract and its own migration.
 *
 * Both presets are DISABLED, and this migration installs nothing: it does not
 * write a compose file, pull the image, download weights, start a container, or
 * contact the endpoint. The stack holds the whole GPU, so an install that also
 * runs local image/video generation must not have it come up on its own. An
 * install that already owns one of these ids is left untouched.
 *
 * `apiKey` ships blank and usually STAYS blank: SGLang authenticates only when
 * the operator started it with `--api-key`. That is the one difference from the
 * vLLM preset, whose container always requires its key.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. These frozen literals are
 * the historical upgrade payload; later default changes require a new migration
 * rather than rewriting this record.
 */

import { makeProviderSeedMigration } from './_lib.js';

const ENDPOINT = 'http://127.0.0.1:18021/v1';

const OPENCODE_CONFIG_CONTENT = '{"permission":"allow","provider":{"sglang":{"npm":"@ai-sdk/openai-compatible","name":"SGLang Qwen3.8-27B (local)","options":{"baseURL":"http://127.0.0.1:18021/v1"}}}}';

const OPENCODE_SGLANG_CLI = {
  id: 'opencode-sglang',
  name: 'OpenCode SGLang (Qwen3.8-27B)',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  endpoint: ENDPOINT,
  // Blank, not absent: the operator pastes a key here only if they launched
  // SGLang behind `--api-key`, and the spawner copies it onto the OpenCode
  // provider's `options.apiKey` when it is non-empty.
  apiKey: '',
  models: ['qwen3.8-27b'],
  defaultModel: 'qwen3.8-27b',
  sglangBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  headlessArgs: [],
};

const OPENCODE_SGLANG_TUI = {
  id: 'opencode-sglang-tui',
  name: 'OpenCode SGLang TUI (Qwen3.8-27B)',
  type: 'tui',
  command: 'opencode',
  args: [],
  endpoint: ENDPOINT,
  apiKey: '',
  models: ['qwen3.8-27b'],
  defaultModel: 'qwen3.8-27b',
  sglangBacked: true,
  timeout: 600000,
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT },
  secretEnvVars: [],
  tuiPromptDelayMs: 2500,
  tuiIdleTimeoutMs: 180000,
};

export default makeProviderSeedMigration({
  label: 'OpenCode SGLang (Qwen3.8-27B)',
  defs: [OPENCODE_SGLANG_CLI, OPENCODE_SGLANG_TUI],
});

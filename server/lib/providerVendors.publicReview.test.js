import { describe, expect, it } from 'vitest';
import { PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE, PUBLIC_REVIEW_EXECUTION_PROFILE } from './agentExecutionProfiles.js';
import {
  buildVendorSpawnConfig,
  supportsPublicReviewProvider,
  supportsPublicReviewActionsProvider,
} from './providerVendors.js';

const localClaude = {
  id: 'claude-ollama',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  args: ['--dangerously-skip-permissions', '--tools', 'Bash'],
  envVars: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
    ANTHROPIC_AUTH_TOKEN: 'local-only',
  },
};

describe('public-review provider profile', () => {
  it('supports only the maintained local non-interactive Claude wrapper', () => {
    expect(supportsPublicReviewProvider(localClaude)).toBe(true);
    expect(supportsPublicReviewProvider({ ...localClaude, type: 'tui' })).toBe(false);
    expect(supportsPublicReviewProvider({ ...localClaude, ollamaBacked: false })).toBe(false);
    expect(supportsPublicReviewProvider({
      ...localClaude,
      envVars: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    })).toBe(false);
    expect(supportsPublicReviewProvider({
      ...localClaude,
      command: 'claude',
      type: 'api',
    })).toBe(false);
  });

  it('supports only a direct Codex CLI for the sandboxed actions stage', () => {
    const codex = {
      id: 'codex-cli',
      type: 'cli',
      command: 'codex',
      models: ['gpt-5.6'],
    };
    expect(supportsPublicReviewActionsProvider(codex)).toBe(true);
    expect(supportsPublicReviewActionsProvider({ ...codex, type: 'tui' })).toBe(false);
    expect(supportsPublicReviewActionsProvider({ ...codex, type: 'api' })).toBe(false);
    expect(supportsPublicReviewActionsProvider({ ...codex, command: 'other-agent' })).toBe(false);
  });

  it('builds the final reviewer with the bounded Codex sandbox and no provider args', () => {
    const config = buildVendorSpawnConfig({
      id: 'codex-cli',
      type: 'cli',
      command: '/opt/example/bin/codex',
      args: ['--dangerously-bypass-approvals-and-sandbox', '--mcp-config', 'unsafe.json'],
    }, {
      effectiveModel: 'gpt-5.6',
      effort: 'high',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    });

    expect(config.args).toEqual(expect.arrayContaining([
      'exec', '--sandbox', 'workspace-write', '--approve-for-me', '--ephemeral', '--ignore-user-config',
      '--model', 'gpt-5.6',
    ]));
    expect(config.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(config.args).not.toContain('--mcp-config');
    expect(config.args).not.toContain('unsafe.json');
  });

  it('rejects the action profile for every non-Codex provider', () => {
    expect(() => buildVendorSpawnConfig(localClaude, {
      effectiveModel: 'safe-model',
      safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE,
    })).toThrow(/public-review-actions posture/);
  });

  it('builds a fresh no-tool argv and ignores dangerous saved provider args', () => {
    const config = buildVendorSpawnConfig(localClaude, {
      effectiveModel: 'qwen3.8:27b',
      effort: 'max',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    });

    expect(config.command).toBe('claude');
    expect(config.stdinMode).toBe('prompt');
    expect(config.args).toContain('--permission-mode');
    expect(config.args).toContain('plan');
    expect(config.args).toContain('--restricted');
    expect(config.args).toContain('--tools');
    expect(config.args[config.args.indexOf('--tools') + 1]).toBe('');
    expect(config.args).toContain('--strict-mcp-config');
    expect(config.args).toContain('--bare');
    expect(config.args).toContain('--model');
    expect(config.args).toContain('qwen3.8:27b');
    expect(config.args).toContain('--effort');
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('Bash');
    expect(config.args).not.toContain('--disallowedTools');
  });

  it('fails closed instead of assigning the profile to cloud or unknown providers', () => {
    expect(() => buildVendorSpawnConfig({
      id: 'claude-cloud',
      type: 'cli',
      command: 'claude',
      envVars: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    }, {
      effectiveModel: 'cloud-model',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    })).toThrow(/no enforced public-review posture/);

    expect(() => buildVendorSpawnConfig({
      id: 'custom-agent',
      type: 'cli',
      command: 'custom-agent',
    }, {
      effectiveModel: 'model',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    })).toThrow(/no enforced public-review posture/);
  });
});

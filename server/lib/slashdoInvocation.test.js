import { describe, it, expect } from 'vitest';
import {
  SLASHDO_INVOCATION_STYLES,
  buildSlashdoSection,
  canTypeSlashCommands,
  isValidSlashdoCommand,
  resolveSlashdoInvocation,
  resolveSlashdoStyle,
  slashdoSkillName,
} from './slashdoInvocation.js';

describe('isValidSlashdoCommand', () => {
  it('accepts bare command names', () => {
    expect(isValidSlashdoCommand('next')).toBe(true);
    expect(isValidSlashdoCommand('plan-task')).toBe(true);
    expect(isValidSlashdoCommand('pr-better')).toBe(true);
  });

  it('rejects anything that could escape commands/do/', () => {
    expect(isValidSlashdoCommand('../../etc/passwd')).toBe(false);
    expect(isValidSlashdoCommand('do/plan-task')).toBe(false);
    expect(isValidSlashdoCommand('plan task')).toBe(false);
    expect(isValidSlashdoCommand('Plan-Task')).toBe(false);
    expect(isValidSlashdoCommand('-leading')).toBe(false);
    expect(isValidSlashdoCommand('trailing-')).toBe(false);
    expect(isValidSlashdoCommand('')).toBe(false);
    expect(isValidSlashdoCommand(null)).toBe(false);
    expect(isValidSlashdoCommand(undefined)).toBe(false);
    expect(isValidSlashdoCommand(42)).toBe(false);
  });
});

describe('slashdoSkillName', () => {
  it('mirrors the installer getSkillName mapping', () => {
    expect(slashdoSkillName('plan-task')).toBe('do-plan-task');
  });
});

describe('resolveSlashdoStyle', () => {
  it('gives Claude Code the namespaced slash command', () => {
    expect(resolveSlashdoStyle({ providerId: 'claude-code' })).toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
    expect(resolveSlashdoStyle({ providerId: 'claude-code-bedrock' })).toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
  });

  it('recognises a path-configured or renamed claude binary', () => {
    expect(resolveSlashdoStyle({ providerId: 'my-custom-agent', providerCommand: '/opt/homebrew/bin/claude' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
    expect(resolveSlashdoStyle({ providerId: 'my-custom-agent', providerCommand: 'C:\\tools\\claude.exe' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
  });

  it('gives OpenCode the flat slash command, path-configured included', () => {
    expect(resolveSlashdoStyle({ providerId: 'opencode' })).toBe(SLASHDO_INVOCATION_STYLES.SLASH_FLAT);
    expect(resolveSlashdoStyle({ providerId: 'renamed', providerCommand: '/usr/local/bin/opencode' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SLASH_FLAT);
  });

  it('gives every skill-based CLI the skill style', () => {
    for (const providerId of ['codex', 'codex-tui', 'grok-cli', 'grok-tui', 'antigravity']) {
      expect(resolveSlashdoStyle({ providerId })).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    }
    expect(resolveSlashdoStyle({ providerId: 'renamed', providerCommand: '/usr/bin/codex' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
  });

  it('falls back to skill for an unidentified provider (inlining works everywhere)', () => {
    expect(resolveSlashdoStyle({})).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    expect(resolveSlashdoStyle({ providerId: 'mystery-cli', providerCommand: '' }))
      .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
  });

  it('falls back to skill in lean mode — a --bare claude session has no project commands', () => {
    expect(resolveSlashdoStyle({ providerId: 'claude-ollama', providerCommand: 'claude', leanMode: true }))
      .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
  });

  describe('assumeClaudeWhenUnknown (#3114)', () => {
    // The posture resolves the command the SPAWNERS would infer from a blank
    // `provider.command` (inferTuiCommand — the same fallback agentTuiSpawning.js
    // and buildCliSpawnConfig apply), rather than guessing "blank means Claude".
    it('resolves a blank command through the spawner fallback', () => {
      expect(resolveSlashdoStyle({ assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
      // A custom provider id with no command launches `claude`, so it IS
      // slashdo-capable — the case a naive `!providerId && !providerCommand`
      // check would have missed.
      expect(resolveSlashdoStyle({ providerId: 'my-custom-agent', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED);
    });

    it('honors the id when the spawner fallback resolves a non-Claude command', () => {
      // `codex-tui` with no command launches `codex`, which gets skills.
      expect(resolveSlashdoStyle({ providerId: 'codex-tui', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerId: 'antigravity-tui', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerId: 'kimi-tui', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    });

    it('never overrides a command the provider actually names', () => {
      expect(resolveSlashdoStyle({ providerCommand: 'agy', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerCommand: 'codex', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerId: 'opencode-tui', providerCommand: 'opencode', assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SLASH_FLAT);
    });

    it('lean mode still wins over the spawner-inferred command', () => {
      expect(resolveSlashdoStyle({ leanMode: true, assumeClaudeWhenUnknown: true }))
        .toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    });

    it('leaves the strict default untouched — a blank command is never read as Claude', () => {
      expect(resolveSlashdoStyle({})).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
      expect(resolveSlashdoStyle({ providerId: 'my-custom-agent' })).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    });
  });
});

describe('canTypeSlashCommands', () => {
  it('is true only for a Claude session that loaded its project commands', () => {
    expect(canTypeSlashCommands({ providerId: 'claude-code' })).toBe(true);
    expect(canTypeSlashCommands({ providerId: 'claude-code-tui', providerCommand: 'claude' })).toBe(true);
    // Path-configured / renamed claude under a custom id — the case the old
    // inline id allowlist in agentPromptBuilder.js missed.
    expect(canTypeSlashCommands({ providerId: 'my-agent', providerCommand: '/opt/homebrew/bin/claude' })).toBe(true);
  });

  it('is false for every host that gets skills or flat commands', () => {
    for (const providerId of ['codex', 'codex-tui', 'grok-tui', 'antigravity-tui', 'kimi-tui']) {
      expect(canTypeSlashCommands({ providerId })).toBe(false);
    }
    expect(canTypeSlashCommands({ providerId: 'opencode-ollama-tui', providerCommand: 'opencode' })).toBe(false);
    expect(canTypeSlashCommands({ providerId: 'claude-ollama-tui', providerCommand: 'claude', leanMode: true })).toBe(false);
  });

  it('defaults to the spawner posture but honors an explicit opt-out', () => {
    expect(canTypeSlashCommands({})).toBe(true);
    expect(canTypeSlashCommands({ providerId: 'my-custom-agent' })).toBe(true);
    // The api path opts out: an unidentified HTTP-API provider is not a latent
    // local `claude` the way a blank CLI/TUI provider is.
    expect(canTypeSlashCommands({ assumeClaudeWhenUnknown: false })).toBe(false);
  });
});

describe('resolveSlashdoInvocation', () => {
  it('returns null without a valid command', () => {
    expect(resolveSlashdoInvocation({})).toBeNull();
    expect(resolveSlashdoInvocation({ command: '' })).toBeNull();
    expect(resolveSlashdoInvocation({ command: '../secrets' })).toBeNull();
  });

  it('renders the Claude Code invocation with args', () => {
    const r = resolveSlashdoInvocation({ command: 'plan-task', args: 'add a widget', providerId: 'claude-code' });
    expect(r.invocation).toBe('/do:plan-task add a widget');
  });

  it('renders the OpenCode invocation', () => {
    const r = resolveSlashdoInvocation({ command: 'plan-task', args: 'add a widget', providerCommand: 'opencode' });
    expect(r.invocation).toBe('/do-plan-task add a widget');
  });

  it('renders a skill directive with no slash-command form', () => {
    const r = resolveSlashdoInvocation({ command: 'plan-task', args: 'add a widget', providerId: 'codex' });
    expect(r.style).toBe(SLASHDO_INVOCATION_STYLES.SKILL);
    expect(r.invocation).toContain('do-plan-task');
    expect(r.invocation).not.toContain('/do:');
  });

  it('omits the argument suffix when there are no args', () => {
    expect(resolveSlashdoInvocation({ command: 'next', providerId: 'claude-code' }).invocation).toBe('/do:next');
    expect(resolveSlashdoInvocation({ command: 'next', args: '   ', providerId: 'claude-code' }).invocation).toBe('/do:next');
  });
});

describe('buildSlashdoSection', () => {
  it('returns empty for an unresolved command', () => {
    expect(buildSlashdoSection(null)).toBe('');
  });

  it('emits the slash invocation in a code block and points at the task above', () => {
    const section = buildSlashdoSection(resolveSlashdoInvocation({ command: 'review', providerId: 'claude-code' }));
    expect(section).toContain('/do:review');
    expect(section).toContain('Apply it to the task described above.');
  });

  // PortOS only exposes slashdo as slash commands through the repo-local
  // `.claude/commands/do/` symlinks, which don't exist in a managed app's
  // workspace — so the procedure travels with the prompt for EVERY host, and a
  // typed invocation is only a shortcut for the ones that happen to have it.
  it.each([
    ['claude-code', '/do:review'],
    ['opencode', '/do-review'],
    ['codex', 'do-review'],
  ])('inlines the command body for %s', (providerId, expectedInvocation) => {
    const section = buildSlashdoSection(
      resolveSlashdoInvocation({ command: 'review', providerId }),
      '# Example Procedure\n\nStep one.'
    );
    expect(section).toContain(expectedInvocation);
    expect(section).toContain('# Example Procedure');
  });

  it('still renders a usable directive when the body could not be loaded', () => {
    const section = buildSlashdoSection(resolveSlashdoInvocation({ command: 'review', providerId: 'codex' }), null);
    expect(section).toContain('do-review');
    expect(section.trim()).not.toBe('');
  });
});

import { describe, it, expect } from 'vitest';
import { buildTuiShellLaunch } from './tuiShellLaunch.js';

// The env half is the whole reason this resolution is server-side: a TUI
// provider's backend lives in `envVars`, so a Shell session handed only the
// command line runs the right binary against the WRONG backend — silently
// billing the vendor cloud for a provider the user pointed at a local daemon.

const OLLAMA_CLAUDE_TUI = {
  id: 'claude-ollama-tui',
  name: 'Claude Ollama TUI',
  type: 'tui',
  command: 'claude',
  args: [],
  ollamaBacked: true,
  defaultModel: 'qwen3:32b',
  envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'local' },
};

describe('buildTuiShellLaunch', () => {
  it('pairs the command line with the provider env that points it at its backend', () => {
    const launch = buildTuiShellLaunch(OLLAMA_CLAUDE_TUI);
    expect(launch.commandLine).toContain('claude');
    expect(launch.commandLine).toContain('qwen3:32b');
    expect(launch.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe('local');
  });

  it('returns null for a non-TUI provider, so callers have one not-launchable case', () => {
    expect(buildTuiShellLaunch({ ...OLLAMA_CLAUDE_TUI, type: 'cli' })).toBeNull();
    expect(buildTuiShellLaunch({ ...OLLAMA_CLAUDE_TUI, type: 'api' })).toBeNull();
    expect(buildTuiShellLaunch(null)).toBeNull();
    expect(buildTuiShellLaunch(undefined)).toBeNull();
  });

  it('falls back to the id-inferred command when the provider stores none', () => {
    const launch = buildTuiShellLaunch({ id: 'codex', type: 'tui', command: '', args: [] });
    expect(launch.commandLine.startsWith('codex')).toBe(true);
  });

  it('applies the vendor posture flag a naive command+args join would drop', () => {
    const launch = buildTuiShellLaunch({ id: 'codex', type: 'tui', command: 'codex', args: [] });
    expect(launch.commandLine).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

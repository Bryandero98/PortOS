import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

// The AI Providers page's "Launch in Shell" button renders from
// `tuiCommandLine` and deep-links to `/shell?provider=<id>` (the launch itself
// re-resolves server-side so the provider's env rides along — see
// lib/tuiShellLaunch.js). This suite pins the DISPLAY half: the line is derived
// from `buildTuiInvocation` — the SAME builder the TUI spawn paths use — so it
// carries the vendor posture flags and the model injection rather than a naive
// `command + args.join(' ')`, and it is derived BEFORE redaction.

const CODEX_TUI = {
  id: 'codex',
  name: 'Codex TUI',
  type: 'tui',
  command: 'codex',
  args: [],
  defaultModel: 'gpt-5',
  envVars: {},
};
const CLAUDE_CLI = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', envVars: {} };
const API_PROVIDER = { id: 'openai', name: 'OpenAI', type: 'api', endpoint: 'https://api.example.com', envVars: {} };

function appWith(providerService) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
}

describe('tuiCommandLine decoration', () => {
  it('GET / gives TUI providers a launch command line and everyone else none', async () => {
    const app = appWith({
      getAllProviders: vi.fn().mockResolvedValue({
        activeProvider: 'codex',
        providers: [CODEX_TUI, CLAUDE_CLI, API_PROVIDER],
      }),
    });

    const res = await request(app).get('/api/providers');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.providers.map((p) => [p.id, p]));
    expect(byId.codex.tuiCommandLine).toContain('codex');
    expect(byId.codex.tuiCommandLine).toContain('gpt-5');
    // The vendor posture flag comes from applyCommandDefaults, not from
    // provider.args — a naive join would have dropped it.
    expect(byId.codex.tuiCommandLine).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(byId['claude-code'].tuiCommandLine).toBeUndefined();
    expect(byId.openai.tuiCommandLine).toBeUndefined();
  });

  it('quotes an argument with spaces so the Shell page types one token', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({ ...CODEX_TUI, args: ['--cd', '/tmp/my apps'] }),
    });

    const res = await request(app).get('/api/providers/codex');
    expect(res.status).toBe(200);
    // Assert the SHAPE, not one dialect's rendering: the quote character is the
    // shell's, and CI runs this suite on Windows too (PowerShell/cmd) as well as
    // POSIX. What must hold everywhere is that the path stayed one quoted token.
    expect(res.body.tuiCommandLine).toMatch(/(['"])\/tmp\/my apps\1/);
  });

  it('falls back to the id-inferred command when the provider stores none', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({ ...CODEX_TUI, command: '' }),
    });

    const res = await request(app).get('/api/providers/codex');
    expect(res.status).toBe(200);
    // Same dialect-agnostic rule — PowerShell renders a quoted command token as
    // `& 'codex'`, so a bare startsWith('codex ') passes on POSIX and fails on
    // the Windows runner.
    expect(res.body.tuiCommandLine).toMatch(/^(?:& )?(['"])?codex\1? /);
  });

  it('derives the line BEFORE redaction, so a secret Bedrock marker is read at its real value', async () => {
    // `buildTuiInvocation` consults envVars for the Bedrock model mapping.
    // `sanitizeProvider` rewrites a secret var to '***', which reads TRUTHY —
    // so deriving after redaction would advertise a Bedrock-mapped model for a
    // provider that has the marker explicitly switched OFF, and the real launch
    // (which reads the raw provider) would run something else.
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({
        ...CODEX_TUI,
        id: 'claude-tui',
        command: 'claude',
        defaultModel: 'claude-opus-4-8',
        envVars: { CLAUDE_CODE_USE_BEDROCK: '0' },
        secretEnvVars: ['CLAUDE_CODE_USE_BEDROCK'],
      }),
    });

    const res = await request(app).get('/api/providers/claude-tui');
    expect(res.status).toBe(200);
    expect(res.body.envVars.CLAUDE_CODE_USE_BEDROCK).toBe('***');
    expect(res.body.tuiCommandLine).toContain('claude-opus-4-8');
    expect(res.body.tuiCommandLine).not.toContain('anthropic.claude-opus-4-8');
  });

  it('never publishes the provider env alongside the command line', async () => {
    // The env is the half that must NOT cross the wire — those values are
    // secret, which is why the deep link carries an ID instead of a command.
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({
        ...CODEX_TUI,
        envVars: { OPENAI_API_KEY: 'sk-not-a-real-key' },
        secretEnvVars: ['OPENAI_API_KEY'],
      }),
    });

    const res = await request(app).get('/api/providers/codex');
    expect(res.status).toBe(200);
    expect(res.body.tuiLaunchEnv).toBeUndefined();
    expect(res.body.tuiCommandLine).not.toContain('sk-not-a-real-key');
    expect(res.body.envVars.OPENAI_API_KEY).toBe('***');
  });
});

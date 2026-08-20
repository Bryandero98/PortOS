import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

// The AI Providers page's "Launch in Shell" button deep-links to
// `/shell?cmd=<tuiCommandLine>`. The line is derived server-side from
// `buildTuiInvocation` — the SAME builder the CoS TUI spawner uses — so a
// hand-launched provider gets its vendor posture flags and its default
// model/effort injection rather than a naive `command + args.join(' ')`.

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
    expect(res.body.tuiCommandLine).toContain("'/tmp/my apps'");
  });

  it('falls back to the id-inferred command when the provider stores none', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({ ...CODEX_TUI, command: '' }),
    });

    const res = await request(app).get('/api/providers/codex');
    expect(res.status).toBe(200);
    expect(res.body.tuiCommandLine.startsWith('codex ')).toBe(true);
  });
});

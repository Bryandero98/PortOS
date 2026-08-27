import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveApps: vi.fn(),
  inspectRuntime: vi.fn(),
  readPreflights: vi.fn(),
}));

vi.mock('./apps.js', () => ({ getActiveApps: mocks.getActiveApps }));
vi.mock('./persistentMindRuntime.js', () => ({ inspectPersistentMindRuntime: mocks.inspectRuntime }));
vi.mock('./persistentMindWorkspacePreflight.js', () => ({
  PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS: 30_000,
  readPersistentMindWorkspacePreflights: (...args) => mocks.readPreflights(...args),
}));

const { buildPersistentMindVisibilityPrompt, readPersistentMindVisibility } = await import('./persistentMindVisibility.js');

const preflight = {
  schemaVersion: 1,
  capturedAt: '2026-08-27T12:00:00.000Z',
  freshness: { state: 'fresh', capturedAt: '2026-08-27T12:00:00.000Z', ageMs: 0, ttlMs: 30_000 },
  truncated: false,
  workspaceDiscovery: 'ready',
  readiness: 'degraded',
  repository: { configured: true, reachable: true },
  checkout: { state: 'clean' },
  workspaces: [{
    id: 'root',
    manifest: 'ready',
    lockfile: { status: 'present', type: 'npm', scope: 'workspace' },
    dependencies: { status: 'absent', source: null },
    engines: { node: { required: '>=22.12.0', actual: '24.0.0', status: 'compatible' }, packageManager: null },
    scripts: { test: ['test'], build: ['build'] },
  }],
  submodules: { configured: false, status: 'not-configured', initialized: null },
  forge: { provider: 'github', cli: 'gh', installed: true, authenticated: true, status: 'ready' },
  reviewers: {
    configured: 1,
    required: { configured: 1, available: 1, unavailable: 0, unknown: 0, status: 'ready' },
    optional: { configured: 0, available: 0, unavailable: 0, unknown: 0, status: 'not-configured' },
    status: 'ready',
  },
  warnings: [{ code: 'workspace-dependencies-unavailable', check: 'dependencies', severity: 'warning', message: 'Dependencies are absent.' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveApps.mockResolvedValue([{ id: 'example-app', name: 'Example App', repoPath: '/private/example-app' }]);
  mocks.inspectRuntime.mockResolvedValue({
    inference: { active: false, residency: { status: 'provider-managed' } },
    context: { chars: 100, maxChars: 1_000, approximateTokens: 25, summaryState: 'current' },
    system: { memory: { usagePercent: 40 } },
  });
  mocks.readPreflights.mockResolvedValue([{ appId: 'example-app', appName: 'Example App', preflight }]);
});

describe('persistent mind visibility', () => {
  it('projects shared runtime, actions, scheduler, health, and workspace facts', async () => {
    const visibility = await readPersistentMindVisibility({
      root: { config: { persistentMindCapabilities: { createTasks: true }, domainAutonomy: { cos: 'execute' } } },
      state: { agents: {}, status: 'idle' },
      profile: { providerId: 'example-provider' },
      prompt: { identity: 'Example identity' },
      provider: { id: 'example-provider', type: 'api' },
      apps: [{ id: 'example-app', name: 'Example App', repoPath: '/private/example-app' }],
      now: 1_000,
    });

    expect(visibility).toMatchObject({
      schemaVersion: 1,
      readiness: 'degraded',
      runtime: { status: 'ready', context: { pressure: 'nominal' } },
      provider: { status: 'configured', type: 'api' },
      actions: { grants: { createTasks: true }, tools: [expect.objectContaining({ id: 'cos.create-task', granted: true })] },
      scheduler: { autonomy: 'execute', capacity: { status: 'unknown' } },
      health: { system: 'available', provider: 'configured', database: 'available', forge: 'ready' },
      workspaces: [{ appId: 'example-app', readiness: 'degraded', preflight: { repository: { reachable: true } } }],
      surfaces: expect.arrayContaining(['mind/visibility', 'workspace-preflight']),
    });

    const prompt = buildPersistentMindVisibilityPrompt(visibility);
    expect(prompt).toContain('workspace-dependencies-unavailable');
    expect(prompt).not.toContain('/private/example-app');
    expect(prompt).not.toContain('git@');
    expect(JSON.stringify(visibility)).not.toContain('/private/example-app');
  });

  it('bounds large workspace projections while retaining an explicit truncation signal', async () => {
    const apps = Array.from({ length: 30 }, (_, index) => ({
      id: `example-${index}`,
      name: `Example App ${index}`,
      repoPath: `/private/example-${index}`,
    }));
    mocks.readPreflights.mockResolvedValue(apps.map((app) => ({
      appId: app.id,
      appName: app.name,
      preflight: { ...preflight, warnings: [] },
    })));

    const visibility = await readPersistentMindVisibility({ apps, now: 2_000 });
    expect(visibility.truncated).toBe(true);
    expect(visibility.characterBudget).toMatchObject({ maxChars: 20_000, truncated: true });
    expect(JSON.stringify(visibility).length).toBeLessThanOrEqual(21_000);
  });
});

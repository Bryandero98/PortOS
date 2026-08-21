import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const serverBuild = (overrides = {}) => ({
  commit: 'abc1234567890abcdef1234567890abcdef12345',
  shortCommit: 'abc1234',
  branch: 'main',
  dirty: false,
  ...overrides,
});

// `__BUILD_STAMP__` is a Vite define read once at module scope (so its identity
// is stable across renders), which means a stub has to be in place BEFORE the
// module graph loads — hence the re-import per case rather than a bare
// `vi.stubGlobal` against an already-imported module.
async function renderPanel({ stamp, ...props } = {}) {
  vi.resetModules();
  if (stamp === undefined) vi.unstubAllGlobals();
  else vi.stubGlobal('__BUILD_STAMP__', stamp);
  const Panel = (await import('./BuildStampPanel.jsx')).default;
  return render(<Panel {...props} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BuildStampPanel', () => {
  it('renders the server commit and branch', async () => {
    await renderPanel({ build: serverBuild() });

    expect(screen.getByText('abc1234 · main')).toBeInTheDocument();
  });

  it('flags a stale bundle when the page and the API were built from different commits', async () => {
    await renderPanel({ stamp: { commit: 'def5678', branch: 'main' }, build: serverBuild() });

    expect(screen.getByText(/stale relative to the server/i)).toBeInTheDocument();
    expect(screen.getByText('def5678')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('confirms agreement when the bundle and the server share a commit', async () => {
    await renderPanel({ stamp: { commit: 'abc1234', branch: 'main' }, build: serverBuild() });

    expect(screen.getByText(/bundle and server agree/i)).toBeInTheDocument();
    expect(screen.queryByText(/stale relative to the server/i)).not.toBeInTheDocument();
  });

  it('never claims agreement when the bundle stamp is unavailable', async () => {
    // The define is genuinely absent under vitest, and in a source-tarball
    // build. Reading it must not throw, and must not report a match nobody
    // verified.
    await renderPanel({ build: serverBuild() });

    expect(screen.getByText(/commit unknown on at least one side/i)).toBeInTheDocument();
    expect(screen.queryByText(/bundle and server agree/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stale relative to the server/i)).not.toBeInTheDocument();
  });

  it('renders "unknown" rather than blank rows when the server has no git metadata', async () => {
    await renderPanel({ build: { commit: null, shortCommit: null, branch: null, dirty: null } });

    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
  });

  it('labels the server row as a boot-time snapshot, not a live tree read', async () => {
    // `dirty` is probed once per process, so presenting it as present-tense
    // would be a claim the data cannot support.
    await renderPanel({ build: serverBuild({ dirty: true }), uptimeFormatted: '3h 12m' });

    expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument();
    expect(screen.getByText('at start · up 3h 12m')).toBeInTheDocument();
  });

  it('survives a missing build block entirely (older server, no build field)', async () => {
    // A newer client can talk to an older server whose /health/details predates
    // this field — the panel must degrade, not crash the whole overview.
    await renderPanel({ build: undefined });

    expect(screen.getByText('Running build')).toBeInTheDocument();
  });
});

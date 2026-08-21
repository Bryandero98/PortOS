import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import BuildStampPanel from './BuildStampPanel.jsx';

const serverBuild = (overrides = {}) => ({
  commit: 'abc1234567890abcdef1234567890abcdef12345',
  shortCommit: 'abc1234',
  branch: 'main',
  dirty: false,
  builtAt: new Date().toISOString(),
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BuildStampPanel', () => {
  it('renders the server commit and branch', () => {
    render(<BuildStampPanel build={serverBuild()} />);

    expect(screen.getByText('abc1234 · main')).toBeInTheDocument();
  });

  it('flags a stale bundle when the page and the API were built from different commits', () => {
    vi.stubGlobal('__BUILD_STAMP__', { commit: 'def5678', branch: 'main', builtAt: new Date().toISOString() });

    render(<BuildStampPanel build={serverBuild()} />);

    expect(screen.getByText(/stale relative to the server/i)).toBeInTheDocument();
    expect(screen.getByText('def5678')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('confirms agreement when the bundle and the server share a commit', () => {
    vi.stubGlobal('__BUILD_STAMP__', { commit: 'abc1234', branch: 'main', builtAt: new Date().toISOString() });

    render(<BuildStampPanel build={serverBuild()} />);

    expect(screen.getByText(/bundle and server agree/i)).toBeInTheDocument();
    expect(screen.queryByText(/stale relative to the server/i)).not.toBeInTheDocument();
  });

  it('never claims agreement when the bundle stamp is unavailable', () => {
    // `__BUILD_STAMP__` is a Vite define — genuinely absent here, which is the
    // same shape a source-tarball build produces. Reading it must not throw a
    // ReferenceError, and must not report a match nobody verified.
    render(<BuildStampPanel build={serverBuild()} />);

    expect(screen.getByText(/commit unknown on at least one side/i)).toBeInTheDocument();
    expect(screen.queryByText(/bundle and server agree/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stale relative to the server/i)).not.toBeInTheDocument();
  });

  it('renders "unknown" rather than blank rows when the server has no git metadata', () => {
    render(<BuildStampPanel build={{ commit: null, shortCommit: null, branch: null, dirty: null }} />);

    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
  });

  it('surfaces an uncommitted-changes server tree', () => {
    render(<BuildStampPanel build={serverBuild({ dirty: true })} />);

    expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument();
  });

  it('survives a missing build block entirely (older server, no build field)', () => {
    // A newer client can talk to an older server whose /health/details predates
    // this field — the panel must degrade, not crash the whole overview.
    render(<BuildStampPanel build={undefined} />);

    expect(screen.getByText('Running build')).toBeInTheDocument();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ getSystemBuild: vi.fn() }));
vi.mock('../../services/api', () => api);

const serverBuild = (overrides = {}) => ({
  commit: 'abc1234567890abcdef1234567890abcdef12345',
  shortCommit: 'abc1234',
  branch: 'main',
  dirty: false,
  ...overrides,
});

// `__BUILD_STAMP__` is a Vite define read once at module scope, and the trusted
// form is additionally gated on the server-injected build-id meta tag — so both
// have to be in place BEFORE the module graph loads.
async function renderPanel({ stamp, served = 'aaaa1111bbbb', build = serverBuild(), ...props } = {}) {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (stamp !== undefined) vi.stubGlobal('__BUILD_STAMP__', stamp);
  document.head.innerHTML = served
    ? `<meta name="portos-build-id" content="${served}">`
    : '';
  api.getSystemBuild.mockResolvedValue(build);
  const Panel = (await import('./BuildStampPanel.jsx')).default;
  const result = render(<Panel {...props} />);
  await waitFor(() => expect(api.getSystemBuild).toHaveBeenCalled());
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  api.getSystemBuild.mockReset();
});

describe('BuildStampPanel', () => {
  it('reads the stamp from its own route, not the peer-scraped health payload', async () => {
    await renderPanel();

    expect(api.getSystemBuild).toHaveBeenCalledWith({ silent: true });
    await waitFor(() => expect(screen.getByText('abc1234 · main')).toBeInTheDocument());
  });

  it('flags a stale bundle when the page and the API were built from different commits', async () => {
    await renderPanel({ stamp: { commit: 'def5678', branch: 'main' } });

    await waitFor(() => expect(screen.getByText(/stale relative to the server/i)).toBeInTheDocument());
    expect(screen.getByText('def5678')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('confirms agreement only when the server tree is also clean', async () => {
    await renderPanel({ stamp: { commit: 'abc1234', branch: 'main' } });

    await waitFor(() => expect(screen.getByText(/what you are looking at is the code that is running/i)).toBeInTheDocument());
  });

  it('does not claim the running code matches when the server tree has uncommitted changes', async () => {
    // Commit-only comparison cannot see working-tree edits — asserting a match
    // here would be a false assurance in the exact session this panel ends.
    await renderPanel({
      stamp: { commit: 'abc1234', branch: 'main' },
      build: serverBuild({ dirty: true }),
    });

    await waitFor(() => expect(screen.getByText(/changes that commit does not include/i)).toBeInTheDocument());
    expect(screen.queryByText(/what you are looking at is the code that is running/i)).not.toBeInTheDocument();
  });

  it('never claims agreement when the bundle stamp is unavailable', async () => {
    await renderPanel();

    await waitFor(() => expect(screen.getByText(/commit unknown on at least one side/i)).toBeInTheDocument());
    expect(screen.queryByText(/what you are looking at is the code that is running/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stale relative to the server/i)).not.toBeInTheDocument();
  });

  it('distrusts the bundle stamp under the dev server, where it is frozen at startup', async () => {
    // No injected meta tag = Vite is serving index.html. The define still holds
    // the commit the dev server STARTED at while HMR serves everything since.
    await renderPanel({ stamp: { commit: 'def5678', branch: 'main' }, served: null });

    await waitFor(() => expect(screen.getByText(/no built bundle to compare/i)).toBeInTheDocument());
    expect(screen.queryByText(/stale relative to the server/i)).not.toBeInTheDocument();
    expect(screen.queryByText('def5678')).not.toBeInTheDocument();
  });

  it('renders "unknown" rather than blank rows when the server has no git metadata', async () => {
    await renderPanel({ build: { commit: null, shortCommit: null, branch: null, dirty: null } });

    await waitFor(() => expect(screen.getAllByText('unknown').length).toBeGreaterThan(0));
  });

  it('labels the server row as a boot-time snapshot, not a live tree read', async () => {
    await renderPanel({ build: serverBuild({ dirty: true }), uptimeFormatted: '3h 12m' });

    await waitFor(() => expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument());
    expect(screen.getByText('at start · up 3h 12m')).toBeInTheDocument();
  });

  it('survives a failed build fetch (older server with no such route)', async () => {
    vi.resetModules();
    document.head.innerHTML = '';
    api.getSystemBuild.mockRejectedValue(new Error('404'));
    const Panel = (await import('./BuildStampPanel.jsx')).default;

    render(<Panel />);

    expect(screen.getByText('Running build')).toBeInTheDocument();
  });
});

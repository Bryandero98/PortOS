import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getRunEventStats: vi.fn(),
  getRunEventProjections: vi.fn(),
  getRunEventDiagnostic: vi.fn(),
}));

vi.mock('../../../services/api', () => api);

import RunEventsTab, { projectionAnnotations, summarizeEventData } from './RunEventsTab';

const STATS = {
  activeEvents: 12,
  archivedEvents: 3,
  maxActiveEvents: 5000,
  maxRetainedEvents: 10000,
  maxEventAgeDays: 30,
  oldestEventAt: '2026-08-01T00:00:00.000Z',
};

const projection = (overrides = {}) => ({
  id: 'run-a',
  runId: 'run-a',
  agentId: 'agent-a',
  taskId: 'task-a',
  status: 'completed',
  startedAt: '2026-08-18T10:00:00.000Z',
  endedAt: '2026-08-18T11:00:00.000Z',
  durationMs: 3600000,
  exitCode: 0,
  success: true,
  orphaned: false,
  interrupted: false,
  paused: false,
  recoveryCount: 0,
  handoffCount: 0,
  reconnectCount: 0,
  pauseCount: 0,
  owner: null,
  outputBytes: null,
  lastOutputAt: null,
  prVerified: null,
  eventCount: 2,
  firstEventAt: '2026-08-18T10:00:00.000Z',
  lastEventAt: '2026-08-18T11:00:00.000Z',
  trace: [],
  ...overrides,
});

const renderTab = (path = '/cos/run-events') => render(
  <MemoryRouter initialEntries={[path]}>
    <RunEventsTab />
  </MemoryRouter>
);

describe('RunEventsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getRunEventStats.mockResolvedValue(STATS);
    api.getRunEventProjections.mockResolvedValue([projection()]);
    api.getRunEventDiagnostic.mockResolvedValue({
      projection: projection(),
      events: [
        { eventId: 'e1', kind: 'run.spawned', at: '2026-08-18T10:00:00.000Z', data: { providerId: 'demo-cli' } },
        { eventId: 'e2', kind: 'run.finalized', at: '2026-08-18T11:00:00.000Z', data: { success: true, exitCode: 0 } },
      ],
    });
  });

  it('renders the ledger bound so "why is this run missing" has an answer', async () => {
    renderTab();
    expect(await screen.findByText('12 / 5000')).toBeInTheDocument();
    expect(screen.getByText('10000 events · 30d')).toBeInTheDocument();
  });

  it('replays the run named by ?run= without the user clicking anything', async () => {
    renderTab('/cos/run-events?run=run-a');

    expect(await screen.findByText('run.spawned')).toBeInTheDocument();
    expect(screen.getByText('run.finalized')).toBeInTheDocument();
    expect(api.getRunEventDiagnostic).toHaveBeenCalledWith('run-a', { silent: true });
  });

  it('puts the selection in the URL, not in local state', async () => {
    // Same contract as every other selectable view: the open diagnostic has to
    // survive a reload and be pasteable to someone else.
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByText('run-a'));

    expect(api.getRunEventDiagnostic).toHaveBeenCalledWith('run-a', { silent: true });
  });

  it('distinguishes an unreachable server from a genuinely empty ledger', async () => {
    // `[]` means "nothing has happened yet"; a failed fetch means "we do not
    // know". Rendering the reassuring empty state for the second would hide a
    // broken server behind a calm screen.
    api.getRunEventStats.mockRejectedValue(new Error('offline'));
    api.getRunEventProjections.mockRejectedValue(new Error('offline'));
    renderTab();

    expect(await screen.findByText(/Could not read the run event ledger/)).toBeInTheDocument();
  });

  it('shows the empty state when the ledger is genuinely empty', async () => {
    api.getRunEventProjections.mockResolvedValue([]);
    renderTab();

    expect(await screen.findByText(/No lifecycle events recorded yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not read/)).not.toBeInTheDocument();
  });
});

describe('projectionAnnotations', () => {
  it('lists only the counts that actually happened', () => {
    expect(projectionAnnotations(projection())).toEqual([]);
    expect(projectionAnnotations(projection({ recoveryCount: 3, orphaned: true, prVerified: false })))
      .toEqual(['3 recovery events', 'orphaned', 'PR unverified']);
  });

  it('says nothing about a PR that was verified, or never checked', () => {
    expect(projectionAnnotations(projection({ prVerified: true }))).toEqual([]);
    expect(projectionAnnotations(projection({ prVerified: null }))).toEqual([]);
  });
});

describe('summarizeEventData', () => {
  it('renders scalars inline and names a redacted stub as redacted', () => {
    expect(summarizeEventData({ exitCode: 0, success: true })).toBe('exitCode=0  success=true');
    expect(summarizeEventData({ prompt: { redacted: 'content', chars: 900 } })).toBe('prompt=«content»');
  });

  it('drops nulls rather than printing them as noise', () => {
    expect(summarizeEventData({ branch: null, category: 'pr-missing' })).toBe('category=pr-missing');
  });
});

import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getPersistentMind: vi.fn(),
  sendPersistentMindMessage: vi.fn(),
  addPersistentMindAnnotation: vi.fn(),
  startPersistentMind: vi.fn(),
  pausePersistentMind: vi.fn(),
  resumePersistentMind: vi.fn(),
  stopPersistentMind: vi.fn(),
  acknowledgePersistentMindEvent: vi.fn(),
  promotePersistentMindEvent: vi.fn(),
}));

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    off: vi.fn((event) => handlers.delete(event)),
    emitServer: (event, data) => handlers.get(event)?.(data),
    reset: () => handlers.clear(),
  };
});

vi.mock('../../../services/api', () => api);
vi.mock('../../../hooks/useSocket', () => ({ useSocket: () => socket }));

import MindTab from './MindTab';

const event = (overrides = {}) => ({
  eventId: 'mind-message:message-1',
  kind: 'mind.message.accepted',
  mindId: 'cos-persistent-mind',
  turnId: null,
  sequence: 1,
  at: '2026-08-26T12:00:00.000Z',
  data: { displayText: 'Review the next bounded slice.' },
  ...overrides,
});

const response = (overrides = {}) => ({
  events: [event()],
  cursor: '1:mind-message:message-1',
  gap: false,
  hasMore: false,
  truncated: false,
  snapshot: {},
  state: { enabled: true, started: true, status: 'waiting', pauseReason: null },
  profile: { enabled: true, providerId: 'demo', model: 'demo-model', effort: 'high', thinkingInterface: 'text' },
  autonomyMode: 'execute',
  ...overrides,
});

const renderTab = (path = '/cos/mind') => render(
  <MemoryRouter initialEntries={[path]}>
    <MindTab />
  </MemoryRouter>
);

describe('MindTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket.reset();
    api.getPersistentMind.mockResolvedValue(response());
    api.sendPersistentMindMessage.mockResolvedValue({ success: true, duplicate: false });
    api.addPersistentMindAnnotation.mockResolvedValue({ success: true, duplicate: false });
    api.startPersistentMind.mockResolvedValue({ success: true });
    api.pausePersistentMind.mockResolvedValue({ success: true });
    api.resumePersistentMind.mockResolvedValue({ success: true });
    api.stopPersistentMind.mockResolvedValue({ success: true });
    api.acknowledgePersistentMindEvent.mockResolvedValue({ success: true });
    api.promotePersistentMindEvent.mockResolvedValue({ success: true });
  });

  it('restores the selected event from the URL and uses a responsive single DOM tree', async () => {
    renderTab('/cos/mind?event=mind-message%3Amessage-1');

    expect(await screen.findByRole('button', { name: /user input/i })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('mind-layout')).toHaveClass('grid');
    expect(screen.getByTestId('mind-layout').className).toContain('lg:grid-cols-');
    expect(screen.getByLabelText('Input type')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeInTheDocument();
  });

  it('never renders a fetch failure as an empty conversation', async () => {
    api.getPersistentMind.mockRejectedValue(new Error('Server unreachable'));
    renderTab();

    expect(await screen.findByText('Conversation unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No conversation yet/)).not.toBeInTheDocument();
  });

  it('deduplicates a socket-triggered cursor backfill', async () => {
    renderTab();
    expect(await screen.findByText('Review the next bounded slice.')).toBeInTheDocument();

    api.getPersistentMind.mockResolvedValue(response({ events: [event()], hasMore: false }));
    await act(async () => { socket.emitServer('cos:mind:event', event()); });

    await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('Review the next bounded slice.')).toHaveLength(1);
  });

  it('shows an explicit reload state when reconnect backfill reports a gap', async () => {
    api.getPersistentMind.mockResolvedValue(response({ gap: true }));
    renderTab();

    expect(await screen.findByText('History gap detected')).toBeInTheDocument();
    expect(screen.getByText(/reloaded from the newest bounded snapshot/i)).toBeInTheDocument();
  });

  it('adopts a null server cursor after a fully pruned gap', async () => {
    renderTab();
    await screen.findByText('Review the next bounded slice.');
    api.getPersistentMind.mockResolvedValueOnce(response({ events: [], cursor: null, gap: true }));
    await act(async () => { socket.emitServer('connect'); });
    await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(2));

    api.getPersistentMind.mockResolvedValueOnce(response());
    await act(async () => { socket.emitServer('cos:mind:status'); });
    await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(3));
    expect(api.getPersistentMind.mock.calls[2][0].cursor).toBeNull();
  });

  it('labels a bounded initial snapshot as truncated', async () => {
    api.getPersistentMind.mockResolvedValue(response({ truncated: true }));
    renderTab();
    expect(await screen.findByText('Showing recent history')).toBeInTheDocument();
  });

  it('keeps a failed message for a visible idempotent retry', async () => {
    const user = userEvent.setup();
    api.sendPersistentMindMessage.mockRejectedValueOnce(new Error('Provider unavailable'));
    renderTab();
    await screen.findByText('Review the next bounded slice.');

    await user.type(screen.getByLabelText('Message'), 'Keep this queued.');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Retry uses the same id/);
    expect(screen.getByLabelText('Message')).toHaveValue('Keep this queued.');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledTimes(2));
    const firstId = api.sendPersistentMindMessage.mock.calls[0][0].id;
    expect(api.sendPersistentMindMessage.mock.calls[1][0].id).toBe(firstId);
  });

  it('mints a new id when failed text is edited into a different submission', async () => {
    const user = userEvent.setup();
    api.sendPersistentMindMessage.mockRejectedValueOnce(new Error('Connection lost'));
    renderTab();
    await screen.findByText('Review the next bounded slice.');
    await user.type(screen.getByLabelText('Message'), 'Original text');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('alert');
    const firstId = api.sendPersistentMindMessage.mock.calls[0][0].id;

    await user.type(screen.getByLabelText('Message'), ' updated');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledTimes(2));
    expect(api.sendPersistentMindMessage.mock.calls[1][0].id).not.toBe(firstId);
  });

  it('renders only redacted display fields, never hidden prompt payloads', async () => {
    api.getPersistentMind.mockResolvedValue(response({ events: [event({
      kind: 'mind.model.result',
      data: { summaryText: 'A synthesized summary.', prompt: { redacted: 'content', chars: 5000 }, apiKey: 'not-rendered' },
    })] }));
    renderTab();

    expect(await screen.findByText('A synthesized summary.')).toBeInTheDocument();
    expect(screen.queryByText(/not-rendered|5000|prompt/i)).not.toBeInTheDocument();
  });
});

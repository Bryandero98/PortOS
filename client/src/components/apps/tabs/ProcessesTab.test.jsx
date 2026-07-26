import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  executeCommand: vi.fn(),
  getProcessesList: vi.fn(),
}));

vi.mock('../../../hooks/useAutoRefetch', () => ({
  useAutoRefetch: () => ({
    data: [{ name: 'example-api', status: 'online', pid: 1, cpu: 0, memory: 0, uptime: null, restarts: 0, pm_id: 1 }],
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useProcessLogs', () => ({
  useProcessLogs: vi.fn(() => ({ logs: [], subscribed: false, clear: vi.fn() })),
}));

vi.mock('../../BrailleSpinner', () => ({ default: () => null }));
vi.mock('../../ui/FormField', () => ({ FormField: ({ children }) => children }));
vi.mock('../../ui/ProcessLogLines', () => ({ default: () => null }));
vi.mock('../../../utils/formatters', () => ({ formatBytes: vi.fn(() => '0 B'), formatDurationMs: vi.fn() }));

import { useProcessLogs } from '../../../hooks/useProcessLogs';
import ProcessesTab from './ProcessesTab';

describe('ProcessesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes its app id to the expanded process log subscription', () => {
    render(<ProcessesTab appId="app-1" pm2ProcessNames={['example-api']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand details for example-api' }));

    expect(useProcessLogs).toHaveBeenLastCalledWith('example-api', { lines: 500, appId: 'app-1' });
  });
});

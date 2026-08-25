import { MemoryRouter } from 'react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetBackupStatus,
  mockGetBackupSnapshots,
  mockDownloadBackupSnapshot,
  mockTriggerBackup,
  mockToast,
} = vi.hoisted(() => ({
  mockGetBackupStatus: vi.fn(),
  mockGetBackupSnapshots: vi.fn(),
  mockDownloadBackupSnapshot: vi.fn(),
  mockTriggerBackup: vi.fn(),
  mockToast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('../services/api', () => ({
  getBackupStatus: (...args) => mockGetBackupStatus(...args),
  getBackupSnapshots: (...args) => mockGetBackupSnapshots(...args),
  downloadBackupSnapshot: (...args) => mockDownloadBackupSnapshot(...args),
  triggerBackup: (...args) => mockTriggerBackup(...args),
}));

vi.mock('./ui/Toast', () => ({ default: mockToast }));

import BackupWidget from './BackupWidget.jsx';

const renderWidget = () => render(
  <MemoryRouter>
    <BackupWidget />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBackupStatus.mockResolvedValue({
    status: 'ok',
    lastRun: '2026-08-25T11:00:00Z',
    nextRun: '2026-08-26T11:00:00Z',
    filesChanged: 2,
    destPath: '/backup/example',
  });
  mockGetBackupSnapshots.mockResolvedValue([{ id: '2026-08-25T11-00-00', fileCount: 3 }]);
  mockTriggerBackup.mockResolvedValue({ snapshotId: 'new-snapshot' });
  mockDownloadBackupSnapshot.mockResolvedValue({ filename: 'portos-snapshot.tar.gz' });
});

describe('BackupWidget snapshots', () => {
  it('offers a download action for each snapshot and confirms success', async () => {
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    const download = await screen.findByRole('button', { name: /Download snapshot 2026-08-25T11-00-00/ });
    fireEvent.click(download);

    await waitFor(() => expect(mockDownloadBackupSnapshot).toHaveBeenCalledWith('2026-08-25T11-00-00'));
    expect(mockToast.success).toHaveBeenCalledWith('Snapshot downloaded');
  });

  it('shows a toast when a snapshot download fails', async () => {
    mockDownloadBackupSnapshot.mockRejectedValue(new Error('Connection lost'));
    renderWidget();

    fireEvent.click(await screen.findByRole('button', { name: 'Snapshots' }));
    await fireEvent.click(await screen.findByRole('button', { name: /Download snapshot 2026-08-25T11-00-00/ }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Download failed: Connection lost'));
  });
});

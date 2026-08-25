import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { downloadBackupSnapshot } from './apiSystem.js';

describe('downloadBackupSnapshot', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalShowSaveFilePicker = window.showSaveFilePicker;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    URL.createObjectURL = vi.fn(() => 'blob:backup');
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAnchorElement.prototype.click = originalClick;
    window.showSaveFilePicker = originalShowSaveFilePicker;
  });

  it('fetches with same-origin credentials and saves the response blob', async () => {
    const blob = new Blob(['snapshot']);
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="custom.tar.gz"' }),
      blob: vi.fn().mockResolvedValue(blob),
    });

    await expect(downloadBackupSnapshot('2026-08-25T12-00-00')).resolves.toEqual({ filename: 'custom.tar.gz' });

    expect(fetch).toHaveBeenCalledWith(
      '/api/backup/snapshots/2026-08-25T12-00-00/download',
      { credentials: 'same-origin' },
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:backup');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed download response', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ error: 'Snapshot not found', code: 'NOT_FOUND' }),
    });

    await expect(downloadBackupSnapshot('missing'))
      .rejects.toMatchObject({ message: 'Snapshot not found', code: 'NOT_FOUND', status: 404 });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('streams large responses to a file picker when available', async () => {
    const pipeTo = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({});
    const blob = vi.fn();
    window.showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="large.tar.gz"' }),
      body: { pipeTo },
      blob,
    });

    await expect(downloadBackupSnapshot('large'))
      .resolves.toEqual({ filename: 'large.tar.gz' });

    expect(window.showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'large.tar.gz' });
    expect(createWritable).toHaveBeenCalledOnce();
    expect(pipeTo).toHaveBeenCalledWith({});
    expect(blob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('falls back to the blob download when the file picker loses activation', async () => {
    const blob = new Blob(['snapshot']);
    const body = { pipeTo: vi.fn() };
    const pickerError = Object.assign(new Error('User activation is required'), { name: 'SecurityError' });
    window.showSaveFilePicker = vi.fn().mockRejectedValue(pickerError);
    fetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body,
      blob: vi.fn().mockResolvedValue(blob),
    });

    await expect(downloadBackupSnapshot('large'))
      .resolves.toEqual({ filename: 'portos-snapshot-large.tar.gz' });

    expect(body.pipeTo).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  });
});

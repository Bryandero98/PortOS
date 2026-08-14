import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import GalleryVideoPicker from './GalleryVideoPicker';

const listVideoHistory = vi.fn();
vi.mock('../../services/apiImageVideo', () => ({
  listVideoHistory: (...args) => listVideoHistory(...args),
}));

vi.mock('../../services/apiMedia', () => ({
  uploadFile: vi.fn(),
}));

vi.mock('../../utils/fileUpload', () => ({
  readFileAsBase64: vi.fn().mockResolvedValue('ZmFrZQ=='),
  JSON_UPLOAD_MAX_FILE_SIZE: 41 * 1024 * 1024,
}));

vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const HISTORY = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4', prompt: 'a neon chase', hidden: false },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', filename: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4', prompt: 'a quiet forest walk', hidden: false },
];

describe('GalleryVideoPicker', () => {
  beforeEach(() => {
    listVideoHistory.mockReset();
    listVideoHistory.mockResolvedValue(HISTORY);
  });

  it('does not fetch when closed', () => {
    render(<GalleryVideoPicker open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(listVideoHistory).not.toHaveBeenCalled();
  });

  it('lists videos on open and selects one', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<GalleryVideoPicker open onClose={onClose} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('a neon chase')).toBeInTheDocument());
    const tile = screen.getByText('a neon chase').closest('.bg-port-card').querySelector('button');
    fireEvent.click(tile);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'video',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }));
    expect(onClose).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ShellImageDrop from './ShellImageDrop';

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: toastMock }));

const imageFile = (name = 'photo.jpg', { size = 1024, type = 'image/jpeg' } = {}) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

// The picker input is the only labelled file control in the panel.
const pickFile = (file) => {
  const input = screen.getByLabelText('Choose a photo to send to this session');
  Object.defineProperty(input, 'files', { configurable: true, get: () => [file] });
  fireEvent.change(input);
};

const openComposer = () => fireEvent.click(screen.getByRole('button', { name: /send a photo/i }));

beforeEach(() => {
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => 'blob:preview');
  global.URL.revokeObjectURL = vi.fn();
});

describe('ShellImageDrop', () => {
  it('keeps the composer closed until the Photo button is clicked', () => {
    render(<ShellImageDrop onSend={vi.fn()} />);
    expect(screen.queryByLabelText(/choose a photo/i)).toBeNull();
    openComposer();
    expect(screen.getByLabelText(/choose a photo/i)).toBeTruthy();
  });

  it('sends the picked file with the typed message', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<ShellImageDrop onSend={onSend} />);
    openComposer();

    const file = imageFile();
    pickFile(file);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '  what is this?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // The message is trimmed before it reaches the PTY.
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(file, 'what is this?'));
  });

  it('sends with no message when the box is left empty', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<ShellImageDrop onSend={onSend} />);
    openComposer();
    const file = imageFile();
    pickFile(file);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(file, ''));
  });

  it('closes and clears on a successful send', async () => {
    render(<ShellImageDrop onSend={vi.fn().mockResolvedValue(true)} />);
    openComposer();
    pickFile(imageFile());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByLabelText('Message')).toBeNull());
  });

  // A failed send must not throw away what the user typed — otherwise a transient
  // upload failure costs them the message and the file pick.
  it('stays open with the message intact when the send fails', async () => {
    render(<ShellImageDrop onSend={vi.fn().mockResolvedValue(false)} />);
    openComposer();
    pickFile(imageFile());
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'retry me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.getByLabelText('Message').value).toBe('retry me');
    expect(screen.getByAltText('photo.jpg')).toBeTruthy();
  });

  it('cannot send without an image', () => {
    render(<ShellImageDrop onSend={vi.fn()} />);
    openComposer();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('rejects a file over the screenshot size cap without selecting it', () => {
    render(<ShellImageDrop onSend={vi.fn()} />);
    openComposer();
    pickFile(imageFile('huge.jpg', { size: 20 * 1024 * 1024 }));
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
    expect(screen.queryByAltText('huge.jpg')).toBeNull();
  });

  it('rejects a non-image file', () => {
    render(<ShellImageDrop onSend={vi.fn()} />);
    openComposer();
    pickFile(imageFile('notes.txt', { type: 'text/plain' }));
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('not an image'));
  });

  it('accepts a pasted image', () => {
    render(<ShellImageDrop onSend={vi.fn()} />);
    openComposer();
    const file = imageFile('pasted.png', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('Message'), { clipboardData: { files: [file] } });
    expect(screen.getByAltText('pasted.png')).toBeTruthy();
  });

  it('Enter sends and Shift+Enter does not', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<ShellImageDrop onSend={onSend} />);
    openComposer();
    pickFile(imageFile());
    const box = screen.getByLabelText('Message');

    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it('removes a picked image without closing the composer', () => {
    render(<ShellImageDrop onSend={vi.fn()} />);
    openComposer();
    pickFile(imageFile());
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(screen.queryByAltText('photo.jpg')).toBeNull();
    expect(screen.getByLabelText(/choose a photo/i)).toBeTruthy();
  });
});

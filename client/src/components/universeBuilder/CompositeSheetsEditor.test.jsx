import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompositeSheetsEditor from './CompositeSheetsEditor.jsx';

// The row's thumbnail slot subscribes to its in-flight job through
// useMediaJobProgress (socket + fetch). Stub it so the rows render offline;
// `job` is mutable so a test can drive the completion / failure paths.
let job = { status: 'queued', filename: null, error: null };
vi.mock('../../hooks/useMediaJobProgress', () => ({
  default: () => ({ progress: 0, step: 0, totalSteps: 0, currentImage: null, ...job }),
}));

const sheet = (over = {}) => ({ kind: 'reference_sheet', label: 'Costume sheet', prompt: 'A clean sheet.', locked: true, ...over });

beforeEach(() => { job = { status: 'queued', filename: null, error: null }; });

describe('CompositeSheetsEditor', () => {
  it('shows the empty state and count', () => {
    render(<CompositeSheetsEditor sheets={[]} onChange={() => {}} />);
    expect(screen.getByText('No composite boards yet.')).toBeInTheDocument();
  });

  it('renders a board with its kind label', () => {
    render(<CompositeSheetsEditor sheets={[sheet({ kind: 'world_pitch_poster', label: 'Pitch' })]} onChange={() => {}} />);
    expect(screen.getByText('Pitch')).toBeInTheDocument();
    expect(screen.getByText('World pitch poster')).toBeInTheDocument();
  });

  it('removing a board calls onChange without it', async () => {
    const onChange = vi.fn();
    render(<CompositeSheetsEditor sheets={[sheet({ label: 'A' }), sheet({ label: 'B' })]} onChange={onChange} />);
    await userEvent.click(screen.getAllByTitle('Remove')[0]);
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ label: 'B' })]);
  });

  it('toggling a board lock flips its locked flag', async () => {
    const onChange = vi.fn();
    render(<CompositeSheetsEditor sheets={[sheet({ locked: true })]} onChange={onChange} />);
    await userEvent.click(screen.getByTitle('Locked — AI expand will preserve this board'));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ locked: false })]);
  });

  it('render button only appears when onRender is provided and gates on canRender', async () => {
    const onRender = vi.fn();
    const s = sheet();
    render(<CompositeSheetsEditor sheets={[s]} onChange={() => {}} onRender={onRender} canRender />);
    await userEvent.click(screen.getByTitle('Render this board'));
    expect(onRender).toHaveBeenCalledWith(s);
  });

  it('shows a thumbnail for a board that has rendered images', () => {
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ label: 'Pitch', imageRefs: ['old.png', 'newest.png'] })]}
        onChange={() => {}}
      />,
    );
    const img = screen.getByAltText('Pitch render');
    expect(img).toHaveAttribute('src', '/data/images/newest.png');
  });

  it('clicking a rendered thumbnail opens the preview with the visible filename', async () => {
    const onPreview = vi.fn();
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ label: 'Pitch', imageRefs: ['newest.png'] })]}
        onChange={() => {}}
        onPreview={onPreview}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /preview pitch render/i }));
    expect(onPreview).toHaveBeenCalledWith('newest.png');
  });

  it('a board with no renders offers the empty-state render affordance', async () => {
    const onRender = vi.fn();
    const s = sheet();
    render(<CompositeSheetsEditor sheets={[s]} onChange={() => {}} onRender={onRender} canRender />);
    await userEvent.click(screen.getByRole('button', { name: /render image for this item/i }));
    expect(onRender).toHaveBeenCalledWith(s);
  });

  it('settles with the rendered filename when the row\'s in-flight job completes', async () => {
    job = { status: 'completed', filename: 'fresh.png', error: null };
    const onJobSettled = vi.fn();
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ id: 'sheet-1' })]}
        onChange={() => {}}
        pendingByEntryId={{ 'sheet-1': 'job-9' }}
        onJobSettled={onJobSettled}
      />,
    );
    await waitFor(() => expect(onJobSettled).toHaveBeenCalledWith('sheet-1', 'fresh.png', 'job-9'));
  });

  it('settles with a null filename on a terminal failure so the parent still clears the pending entry', async () => {
    job = { status: 'failed', filename: null, error: 'boom' };
    const onJobSettled = vi.fn();
    render(
      <CompositeSheetsEditor
        sheets={[sheet({ id: 'sheet-1' })]}
        onChange={() => {}}
        pendingByEntryId={{ 'sheet-1': 'job-9' }}
        onJobSettled={onJobSettled}
      />,
    );
    await waitFor(() => expect(onJobSettled).toHaveBeenCalledWith('sheet-1', null, 'job-9'));
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  addLoomTransition: vi.fn(),
  branchLoomNode: vi.fn(),
  deleteLoomNode: vi.fn(),
  deleteLoomTransition: vi.fn(),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  updateLoomNode: vi.fn(),
  updateLoomTransition: vi.fn(),
}));
vi.mock('../MediaImage', () => ({ default: () => null }));

import {
  addLoomTransition, deleteLoomTransition, generateVideo, updateLoomNode, updateLoomTransition,
} from '../../services/api';
import LoomNodeEditor from './LoomNodeEditor';

const loom = { id: 'loom-1', name: 'Example Story', format: 'teleplay', styleNotes: '' };
const scene = 'EXT. ANCIENT GATE - NIGHT\n\nThe gate groans open.';

// One scene with a single existing path, plus a second scene to point at.
const makeNodes = (transitions) => ([
  {
    id: 'n1', title: 'The Gate', prose: scene, image: 'scene.png',
    imagePrompt: 'an ancient gate', videoPrompt: 'legacy motion prompt', transitions,
  },
  { id: 'n2', title: 'Inside', prose: 'Torchlight.', transitions: [] },
]);

const existingPath = { id: 'tr-1', targetNodeId: 'n2', intent: 'enter', triggers: ['go in'], description: '' };

const renderEditor = (transitions = [existingPath]) => {
  const nodes = makeNodes(transitions);
  const episode = { id: 'ep-1', startNodeId: 'n1', nodes };
  const onLoomUpdate = vi.fn();
  render(
    <LoomNodeEditor
      loom={loom}
      episode={episode}
      node={nodes[0]}
      onLoomUpdate={onLoomUpdate}
      onClearSelection={() => {}}
    />,
  );
  return { onLoomUpdate };
};

beforeEach(() => vi.clearAllMocks());

describe('LoomNodeEditor paths', () => {
  it('creates a path server-side first, so the new row already carries its id', async () => {
    const user = userEvent.setup();
    const minted = { id: 'tr-9', targetNodeId: 'n2', intent: '', triggers: [], description: '' };
    addLoomTransition.mockResolvedValue({ loom: { id: 'loom-1' }, transition: minted });
    const { onLoomUpdate } = renderEditor([]);

    await user.click(screen.getByRole('button', { name: '+ Add path' }));

    await waitFor(() => expect(addLoomTransition).toHaveBeenCalledTimes(1));
    expect(addLoomTransition).toHaveBeenCalledWith(
      'loom-1', 'ep-1', 'n1', { targetNodeId: 'n2', intent: '' }, { silent: true },
    );
    expect(onLoomUpdate).toHaveBeenCalledWith({ id: 'loom-1' });
    await waitFor(() => expect(screen.getByText('Paths out (1)')).toBeInTheDocument());
    // The whole-array node PATCH is not how a path is added any more.
    expect(updateLoomNode).not.toHaveBeenCalled();
  });

  it('saves one edited row by id rather than replaying the array', async () => {
    const user = userEvent.setup();
    updateLoomTransition.mockResolvedValue({ id: 'loom-1' });
    renderEditor();

    const intent = screen.getByLabelText('Intent');
    await user.clear(intent);
    await user.type(intent, 'slip past');
    await user.tab();

    await waitFor(() => expect(updateLoomTransition).toHaveBeenCalledTimes(1));
    expect(updateLoomTransition).toHaveBeenCalledWith('loom-1', 'ep-1', 'n1', 'tr-1', {
      targetNodeId: 'n2', intent: 'slip past', triggers: ['go in'], description: '',
    }, { silent: true });
    expect(updateLoomNode).not.toHaveBeenCalled();
  });

  it('skips the round-trip when a blurred row still matches the record', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByLabelText('Intent'));
    await user.tab();

    expect(updateLoomTransition).not.toHaveBeenCalled();
  });

  it('deletes one path by id', async () => {
    const user = userEvent.setup();
    deleteLoomTransition.mockResolvedValue({ id: 'loom-1' });
    const { onLoomUpdate } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Remove path' }));

    await waitFor(() => expect(deleteLoomTransition).toHaveBeenCalledTimes(1));
    expect(deleteLoomTransition).toHaveBeenCalledWith('loom-1', 'ep-1', 'n1', 'tr-1', { silent: true });
    expect(onLoomUpdate).toHaveBeenCalledWith({ id: 'loom-1' });
    expect(screen.getByText('Paths out (0)')).toBeInTheDocument();
  });
});

describe('LoomNodeEditor scene media', () => {
  it('queues a local video from the teleplay scene and rendered still', async () => {
    const user = userEvent.setup();
    generateVideo.mockResolvedValue({ jobId: 'video-1', status: 'queued' });
    renderEditor();

    expect(screen.queryByLabelText('Video prompt')).not.toBeInTheDocument();
    expect(screen.getByText('Uses the scene above as the video prompt.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Generate video' }));

    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
    expect(generateVideo).toHaveBeenCalledWith({
      prompt: scene,
      backend: 'local',
      mode: 'image',
      sourceImageFile: 'scene.png',
      disableAudio: true,
      fableLoom: JSON.stringify({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'n1' }),
    });
  });

  it('uses the scene for text-to-video when no rendered still exists', async () => {
    const user = userEvent.setup();
    generateVideo.mockResolvedValue({ jobId: 'video-2', status: 'queued' });
    const nodes = makeNodes([]).map((node) => node.id === 'n1'
      ? { ...node, image: null }
      : node);
    render(
      <LoomNodeEditor
        loom={loom}
        episode={{ id: 'ep-1', nodes }}
        node={nodes[0]}
        onLoomUpdate={vi.fn()}
        onClearSelection={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Generate video' }));

    await waitFor(() => expect(generateVideo).toHaveBeenCalledTimes(1));
    expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      prompt: scene, backend: 'local', mode: 'text', fableLoom: expect.any(String),
    }));
    expect(generateVideo.mock.calls[0][0]).not.toHaveProperty('sourceImageFile');
  });
});

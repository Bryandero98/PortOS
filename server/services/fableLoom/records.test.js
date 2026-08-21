import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real per-suite tmpdir backing the fableloom/ collectionStore layout (the
// NODE_ENV=test escape-hatch backend). Wiped per test.
const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'fableloom-records-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT },
  };
});

const {
  addEpisode, addNode, attachNodeImage, createLoom, deleteEpisode, deleteLoom,
  deleteNode, getLoom, listLooms, sanitizeLoom, updateEpisode, updateLoom, updateNode,
} = await import('./records.js');
const { _resetFableLoomBackend } = await import('./store.js');

beforeEach(() => {
  rmSync(join(TEST_DATA_ROOT, 'fableloom'), { recursive: true, force: true });
  _resetFableLoomBackend();
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
});

const makeLoom = (fields = {}) => createLoom({ name: 'The Hollow Crown', ...fields });

describe('sanitizeLoom', () => {
  it('rejects records without an id or name', () => {
    expect(sanitizeLoom(null)).toBeNull();
    expect(sanitizeLoom({ id: 'loom-1' })).toBeNull();
    expect(sanitizeLoom({ name: 'x' })).toBeNull();
  });

  it('drops malformed nodes and transitions but keeps authored dangling targets', () => {
    const loom = sanitizeLoom({
      id: 'loom-1',
      name: 'X',
      episodes: [{
        id: 'ep-1',
        startNodeId: 'n1',
        nodes: [
          { id: 'n1', title: 'A', transitions: [
            { id: 't1', targetNodeId: 'n-gone', intent: 'leap' }, // dangling: kept (validation surfaces it)
            { targetNodeId: '', intent: 'no target' },            // no target: dropped
            'garbage',
          ] },
          { title: 'no id — dropped' },
        ],
      }],
    });
    expect(loom.episodes[0].nodes).toHaveLength(1);
    expect(loom.episodes[0].nodes[0].transitions).toHaveLength(1);
    expect(loom.episodes[0].nodes[0].transitions[0].targetNodeId).toBe('n-gone');
  });

  it('repoints a missing startNodeId at the first node', () => {
    const loom = sanitizeLoom({
      id: 'loom-1',
      name: 'X',
      episodes: [{ id: 'ep-1', startNodeId: 'gone', nodes: [{ id: 'n1' }] }],
    });
    expect(loom.episodes[0].startNodeId).toBe('n1');
  });

  it('rejects unsafe image filenames', () => {
    const loom = sanitizeLoom({
      id: 'loom-1',
      name: 'X',
      episodes: [{ id: 'ep-1', nodes: [{ id: 'n1', image: '../../etc/passwd' }, { id: 'n2', image: 'render.png' }] }],
    });
    expect(loom.episodes[0].nodes[0].image).toBeNull();
    expect(loom.episodes[0].nodes[1].image).toBe('render.png');
  });
});

describe('loom CRUD', () => {
  it('creates, lists, patches, and deletes a loom', async () => {
    const loom = await makeLoom({ logline: 'A crown that remembers.', universeId: 'uni-1' });
    expect(loom.id).toMatch(/^loom-/);
    expect(loom.universeId).toBe('uni-1');

    expect((await listLooms()).map((l) => l.id)).toEqual([loom.id]);

    const patched = await updateLoom(loom.id, { logline: 'New logline', seriesId: 'ser-9' });
    expect(patched.logline).toBe('New logline');
    expect(patched.seriesId).toBe('ser-9');
    // Absent keys preserve current values.
    expect(patched.universeId).toBe('uni-1');

    await deleteLoom(loom.id);
    expect(await getLoom(loom.id)).toBeNull();
  });

  it('rejects creating a loom without a name', async () => {
    await expect(createLoom({ name: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('episodes', () => {
  it('adds episodes with sequential numbers and deletes them', async () => {
    const loom = await makeLoom();
    let updated = await addEpisode(loom.id, { title: 'Pilot' });
    updated = await addEpisode(loom.id, { title: 'Second' });
    expect(updated.episodes.map((e) => [e.number, e.title])).toEqual([[1, 'Pilot'], [2, 'Second']]);

    const [first] = updated.episodes;
    updated = await updateEpisode(loom.id, first.id, { synopsis: 'It begins.' });
    expect(updated.episodes[0].synopsis).toBe('It begins.');

    updated = await deleteEpisode(loom.id, first.id);
    expect(updated.episodes.map((e) => e.title)).toEqual(['Second']);
    await expect(deleteEpisode(loom.id, 'ep-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('nodes and transitions', () => {
  const setup = async () => {
    const loom = await makeLoom();
    const withEp = await addEpisode(loom.id, { title: 'Pilot' });
    return { loomId: loom.id, episodeId: withEp.episodes[0].id };
  };

  it('first node becomes the start node; fromNodeId wires a branch', async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'Opening', prose: 'You wake.' });
    const ep = () => updated.episodes[0];
    const start = ep().nodes[0];
    expect(ep().startNodeId).toBe(start.id);

    updated = await addNode(loomId, episodeId, {
      title: 'The Door', fromNodeId: start.id, fromIntent: 'open the door',
    });
    const startNow = updated.episodes[0].nodes.find((n) => n.id === start.id);
    const door = updated.episodes[0].nodes.find((n) => n.title === 'The Door');
    expect(startNow.transitions).toHaveLength(1);
    expect(startNow.transitions[0]).toMatchObject({ targetNodeId: door.id, intent: 'open the door' });
  });

  it('patches node fields and replaces transitions', async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'A' });
    updated = await addNode(loomId, episodeId, { title: 'B' });
    const [a, b] = updated.episodes[0].nodes;

    updated = await updateNode(loomId, episodeId, a.id, {
      prose: 'New prose',
      isEnding: false,
      transitions: [{ targetNodeId: b.id, intent: 'press on', triggers: ['keep going'] }],
    });
    const aNow = updated.episodes[0].nodes.find((n) => n.id === a.id);
    expect(aNow.prose).toBe('New prose');
    expect(aNow.transitions[0]).toMatchObject({ targetNodeId: b.id, intent: 'press on', triggers: ['keep going'] });
    expect(aNow.transitions[0].id).toMatch(/^tr-/);
  });

  it('deleting a node strips inbound transitions and repoints the start', async () => {
    const { loomId, episodeId } = await setup();
    let updated = await addNode(loomId, episodeId, { title: 'A' });
    const a = updated.episodes[0].nodes[0];
    updated = await addNode(loomId, episodeId, { title: 'B', fromNodeId: a.id, fromIntent: 'go' });
    const b = updated.episodes[0].nodes.find((n) => n.title === 'B');

    updated = await deleteNode(loomId, episodeId, b.id);
    const aNow = updated.episodes[0].nodes.find((n) => n.id === a.id);
    expect(aNow.transitions).toEqual([]);

    updated = await deleteNode(loomId, episodeId, a.id);
    expect(updated.episodes[0].startNodeId).toBeNull();
  });
});

describe('attachNodeImage', () => {
  it('files a completed render onto its node', async () => {
    const loom = await makeLoom();
    let updated = await addEpisode(loom.id, {});
    const episodeId = updated.episodes[0].id;
    updated = await addNode(loom.id, episodeId, { title: 'A' });
    const node = updated.episodes[0].nodes[0];

    const attached = await attachNodeImage(loom.id, episodeId, node.id, { filename: 'job-1.png', jobId: 'job-1' });
    expect(attached).toMatchObject({ id: node.id, image: 'job-1.png', imageJobId: 'job-1' });
    expect((await getLoom(loom.id)).episodes[0].nodes[0].image).toBe('job-1.png');
  });

  it('returns null (no throw) when the target is gone or the filename is unsafe', async () => {
    const loom = await makeLoom();
    const updated = await addEpisode(loom.id, {});
    const episodeId = updated.episodes[0].id;
    expect(await attachNodeImage(loom.id, episodeId, 'node-gone', { filename: 'x.png' })).toBeNull();
    expect(await attachNodeImage(loom.id, episodeId, 'node-gone', { filename: '../x.png' })).toBeNull();
    expect(await attachNodeImage('loom-missing', episodeId, 'node-gone', { filename: 'x.png' })).toBeNull();
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-agent-activity-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const { getActivityTimeline } = await import('./agentActivity.js');

const activityRoot = join(tempRoot, 'agents', 'activity');

const writeDay = async (agentId, date, activities) => {
  const directory = join(activityRoot, agentId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${date}.json`), JSON.stringify({ activities }));
};

const entry = (id, timestamp) => ({ id, action: 'example', status: 'completed', timestamp });

describe('getActivityTimeline', () => {
  beforeEach(async () => {
    await rm(activityRoot, { recursive: true, force: true });
  });

  afterAll(cleanup);

  it('continues across midnight into older day files', async () => {
    await writeDay('agent-a', '2026-08-23', [entry('new', '2026-08-23T00:01:00.000Z')]);
    await writeDay('agent-a', '2026-08-22', [entry('old', '2026-08-22T23:59:00.000Z')]);

    await expect(getActivityTimeline({ limit: 2 })).resolves.toMatchObject([
      { id: 'new', agentId: 'agent-a' },
      { id: 'old', agentId: 'agent-a' },
    ]);
  });

  it('pages beyond three times the page limit without repeating the shallow window', async () => {
    await writeDay('agent-a', '2026-08-23', Array.from({ length: 10 }, (_, index) => (
      entry(`item-${index}`, `2026-08-23T00:00:${String(10 - index).padStart(2, '0')}.000Z`)
    )));

    await expect(getActivityTimeline({
      limit: 2,
      beforeTimestamp: '2026-08-23T00:00:05.000Z',
    })).resolves.toMatchObject([{ id: 'item-6' }, { id: 'item-7' }]);
  });

  it('returns a stable newest-first order across agents', async () => {
    await writeDay('agent-b', '2026-08-23', [
      entry('b-later', '2026-08-23T12:00:01.000Z'),
      entry('b-tie', '2026-08-23T12:00:00.000Z'),
    ]);
    await writeDay('agent-a', '2026-08-23', [entry('a-tie', '2026-08-23T12:00:00.000Z')]);

    const first = await getActivityTimeline({ limit: 3 });
    const second = await getActivityTimeline({ limit: 3 });

    expect(first.map(({ id }) => id)).toEqual(['b-later', 'a-tie', 'b-tie']);
    expect(second).toEqual(first);
  });

  it('skips empty days while walking backward', async () => {
    await writeDay('agent-a', '2026-08-23', []);
    await writeDay('agent-a', '2026-08-21', [entry('older', '2026-08-21T09:00:00.000Z')]);

    await expect(getActivityTimeline({ limit: 1 })).resolves.toMatchObject([
      { id: 'older', agentId: 'agent-a' },
    ]);
  });
});

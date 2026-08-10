import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  spawn: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal(),
  existsSync: runtimeMocks.existsSync,
}));
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: runtimeMocks.spawn,
}));

import {
  invalidateByovReadyCache, isByovRuntimeReady, isPinnedSourceStatusClean, modelAnchorsLastFrame,
} from './runtimes.js';

const REVISION = 'fcd9e9b79a1d6018d91ac477c0968de1fa067e49';

const statusChild = (stdout) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
};

beforeEach(() => {
  invalidateByovReadyCache();
  runtimeMocks.existsSync.mockReset().mockReturnValue(true);
  runtimeMocks.spawn.mockReset();
});

describe('isPinnedSourceStatusClean', () => {
  it('accepts the exact revision when the scoped source package is clean', () => {
    expect(isPinnedSourceStatusClean([
      `# branch.oid ${REVISION}`,
      '# branch.head (detached)',
      '',
    ].join('\n'), REVISION)).toBe(true);
  });

  it.each([
    [`# branch.oid ${'0'.repeat(40)}\n# branch.head main\n`, 'stale revision'],
    [`# branch.oid ${REVISION}\n1 .M N... 100644 100644 100644 abc abc minimax_h3_mlx/pipeline.py\n`, 'tracked edit'],
    [`# branch.oid ${REVISION}\n? minimax_h3_mlx/shadow.py\n`, 'untracked module'],
  ])('rejects a %s', (stdout) => {
    expect(isPinnedSourceStatusClean(stdout, REVISION)).toBe(false);
  });
});

describe('isByovRuntimeReady', () => {
  it('does not execute the import probe when the H3 source checkout is stale', async () => {
    runtimeMocks.spawn.mockImplementationOnce(() => statusChild([
      `# branch.oid ${'0'.repeat(40)}`,
      '# branch.head main',
      '',
    ].join('\n')));

    await expect(isByovRuntimeReady('minimax_h3')).resolves.toBe(false);

    expect(runtimeMocks.spawn).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.spawn.mock.calls[0][0]).toBe('git');
  });
});

// One declaration feeds three consumers: buildArgs (which forwards the last
// frame), the last-image resize in local.js, and the client's advisory note via
// the `lastFrameAnchored` field listVideoModels() decorates onto each model.
describe('modelAnchorsLastFrame', () => {
  it.each([
    ['ltx2', true],
    ['minimax_h3', true],
    ['mlx_video', false],
    ['wan22', false],
    ['hunyuan', false],
  ])('reports %s as %s', (runtime, anchored) => {
    expect(modelAnchorsLastFrame({ runtime })).toBe(anchored);
  });

  it('treats a missing model or runtime as not anchored', () => {
    expect(modelAnchorsLastFrame(null)).toBe(false);
    expect(modelAnchorsLastFrame({})).toBe(false);
  });
});

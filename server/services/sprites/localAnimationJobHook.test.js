/**
 * The sprite local-render completion hook (#4876).
 *
 * The property under test is DURABILITY: this hook holds no in-memory record of
 * in-flight work, so every path — a job settling live, a job that settled while
 * the process was down, a job that produced no clip — has to be recoverable from
 * the job's own persisted params alone. A hook that quietly depended on state
 * from the enqueueing request would pass a happy-path test and still lose a
 * multi-hour render to a restart, which is exactly the bug it replaced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const mediaJobEvents = new EventEmitter();
let queuedJobs = [];
vi.mock('../mediaJobQueue/index.js', () => ({
  mediaJobEvents,
  listJobs: () => queuedJobs,
}));

vi.mock('./paths.js', async (importOriginal) => ({
  ...await importOriginal(),
  spriteDir: (recordId) => `/sprites/${recordId}`,
}));

// The on-disk run records, keyed by the record path the hook derives. Every test
// states the run state it is about — which is the whole point of the settle
// guard, so it must not be faked away.
let runRecords = {};
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...await importOriginal(),
  readJSONFile: async (path) => runRecords[path] ?? null,
}));

const runPath = (recordId, runId) => `/sprites/${recordId}/runs/${runId}/animation-run.json`;

const collectLocalAnimationClip = vi.fn(async () => true);
vi.mock('./localAnimationRender.js', () => ({
  collectLocalAnimationClip: (...args) => collectLocalAnimationClip(...args),
}));

const attachTuiWalkResult = vi.fn(async () => {});
vi.mock('./walk.js', () => ({
  attachTuiWalkResult: (...args) => attachTuiWalkResult(...args),
}));

const attachTrackTuiResult = vi.fn(async () => {});
vi.mock('./animationTrackWorkflow.js', () => ({
  attachTrackTuiResult: (...args) => attachTrackTuiResult(...args),
}));

const { initSpriteLocalAnimationHook, __testing } = await import('./localAnimationJobHook.js');
const { decodeSpriteAnimationJob, settleSpriteAnimationJob, reconcileSettledSpriteJobs } = __testing;

const walkJob = (overrides = {}) => ({
  id: 'mjob-1',
  kind: 'video',
  status: 'completed',
  params: {
    spriteAnimation: { recordId: 'hero', runId: 'walk-east-abc12345', track: 'walk', direction: 'east' },
  },
  ...overrides,
});

const trackJob = (overrides = {}) => ({
  id: 'mjob-2',
  kind: 'video',
  status: 'completed',
  params: {
    spriteAnimation: { recordId: 'hero', runId: 'scanner-east-abc12345', track: 'scanner', direction: 'east' },
  },
  ...overrides,
});

beforeEach(() => {
  queuedJobs = [];
  runRecords = {
    [runPath('hero', 'walk-east-abc12345')]: { id: 'walk-east-abc12345', status: 'rendering' },
    [runPath('hero', 'scanner-east-abc12345')]: { id: 'scanner-east-abc12345', status: 'rendering' },
  };
  collectLocalAnimationClip.mockClear();
  collectLocalAnimationClip.mockResolvedValue(true);
  attachTuiWalkResult.mockReset();
  attachTuiWalkResult.mockResolvedValue(undefined);
  attachTrackTuiResult.mockReset();
  attachTrackTuiResult.mockResolvedValue(undefined);
});
afterEach(() => __testing.reset());

describe('decodeSpriteAnimationJob', () => {
  it('accepts a fully-formed sprite animation job', () => {
    expect(decodeSpriteAnimationJob(walkJob())).toEqual({
      recordId: 'hero', runId: 'walk-east-abc12345', track: 'walk', direction: 'east',
    });
  });

  it('ignores every other media job on the queue', () => {
    expect(decodeSpriteAnimationJob({ kind: 'image', params: { spriteAnimation: {} } })).toBeNull();
    expect(decodeSpriteAnimationJob({ kind: 'video', params: {} })).toBeNull();
    expect(decodeSpriteAnimationJob({ kind: 'video', params: { musicVideo: { projectId: 'p' } } })).toBeNull();
    expect(decodeSpriteAnimationJob(null)).toBeNull();
  });

  it('refuses a tag missing any id it would need to find the run', () => {
    // A partial tag would otherwise reach `spriteDir(undefined)` and file the
    // clip into a phantom directory.
    for (const partial of [
      { runId: 'r', track: 'walk' },
      { recordId: 'hero', track: 'walk' },
      { recordId: 'hero', runId: 'r' },
    ]) {
      expect(decodeSpriteAnimationJob({ kind: 'video', params: { spriteAnimation: partial } })).toBeNull();
    }
  });

  it('accepts a non-directional track, whose facing is derived server-side', () => {
    const decoded = decodeSpriteAnimationJob({
      kind: 'video',
      params: { spriteAnimation: { recordId: 'hero', runId: 'ambient-abc', track: 'ambient' } },
    });
    expect(decoded).toEqual({ recordId: 'hero', runId: 'ambient-abc', track: 'ambient', direction: null });
  });
});

describe('settleSpriteAnimationJob', () => {
  it('stages the clip and files it through the WALK attach', async () => {
    await settleSpriteAnimationJob(walkJob());
    expect(collectLocalAnimationClip).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'mjob-1',
      videoAbs: '/sprites/hero/runs/walk-east-abc12345/generated/source-video.mp4',
    }));
    expect(attachTuiWalkResult).toHaveBeenCalledWith(
      'hero', 'walk-east-abc12345', '/sprites/hero/runs/walk-east-abc12345/generated/source-video.mp4',
    );
    expect(attachTrackTuiResult).not.toHaveBeenCalled();
  });

  it('routes a non-walk track to the TRACK attach, naming its track', async () => {
    await settleSpriteAnimationJob(trackJob());
    expect(attachTrackTuiResult).toHaveBeenCalledWith(
      'scanner', 'hero', 'scanner-east-abc12345',
      '/sprites/hero/runs/scanner-east-abc12345/generated/source-video.mp4',
    );
    expect(attachTuiWalkResult).not.toHaveBeenCalled();
  });

  it('still runs the attach on a FAILED job, so the run leaves rendering', async () => {
    // The attach is the only thing that writes a terminal state. Skipping it for
    // a failed job strands the run at 'rendering' — permanently on the track
    // lane, whose in-flight guard then 409s every retry.
    await settleSpriteAnimationJob(walkJob({ status: 'failed' }));
    expect(collectLocalAnimationClip).not.toHaveBeenCalled();
    expect(attachTuiWalkResult).toHaveBeenCalled();
  });

  it('still runs the attach on a CANCELED job', async () => {
    await settleSpriteAnimationJob(trackJob({ status: 'canceled' }));
    expect(attachTrackTuiResult).toHaveBeenCalled();
  });

  it('still runs the attach when staging the clip failed', async () => {
    collectLocalAnimationClip.mockResolvedValue(false);
    await settleSpriteAnimationJob(walkJob());
    expect(attachTuiWalkResult).toHaveBeenCalled();
  });

  it('does nothing at all for a job that is not a sprite render', async () => {
    expect(await settleSpriteAnimationJob({ kind: 'video', params: {} })).toBe(false);
    expect(attachTuiWalkResult).not.toHaveBeenCalled();
    expect(attachTrackTuiResult).not.toHaveBeenCalled();
  });
});

describe('settle guard — a run is filed exactly once', () => {
  it('does nothing for a run that is already a candidate', async () => {
    // The boot pass sweeps the archive unconditionally, so a job outlives the
    // run it filed by the archive's whole retention. Re-settling would re-stage
    // the clip and re-run the entire postprocess — minutes of frame decoding —
    // and restamp the manifest with TODAY's anchor for a clip rendered from a
    // previous one.
    runRecords[runPath('hero', 'walk-east-abc12345')] = { status: 'candidate' };
    expect(await settleSpriteAnimationJob(walkJob())).toBe(false);
    expect(collectLocalAnimationClip).not.toHaveBeenCalled();
    expect(attachTuiWalkResult).not.toHaveBeenCalled();
  });

  it('does nothing for a run already filed as an error', async () => {
    runRecords[runPath('hero', 'walk-east-abc12345')] = { status: 'error' };
    expect(await settleSpriteAnimationJob(walkJob({ status: 'failed' }))).toBe(false);
    expect(attachTuiWalkResult).not.toHaveBeenCalled();
  });

  it('does nothing while an earlier settle is still postprocessing', async () => {
    runRecords[runPath('hero', 'scanner-east-abc12345')] = { status: 'postprocessing' };
    expect(await settleSpriteAnimationJob(trackJob())).toBe(false);
    expect(attachTrackTuiResult).not.toHaveBeenCalled();
  });

  it('does nothing when the run record is gone entirely', async () => {
    // A deleted sprite, or a record the write never landed for. Filing into a
    // phantom directory would litter, not help.
    runRecords = {};
    expect(await settleSpriteAnimationJob(walkJob())).toBe(false);
    expect(attachTuiWalkResult).not.toHaveBeenCalled();
  });

  it('files a rendering run, then ignores a second terminal event for it', async () => {
    // The one-shot property end to end: the guard reads the record, so the
    // second call only skips because the FIRST one moved the run on.
    let filed = 0;
    attachTuiWalkResult.mockImplementation(async () => {
      filed += 1;
      runRecords[runPath('hero', 'walk-east-abc12345')] = { status: 'candidate' };
    });
    expect(await settleSpriteAnimationJob(walkJob())).toBe(true);
    expect(await settleSpriteAnimationJob(walkJob({ status: 'canceled' }))).toBe(false);
    expect(filed).toBe(1);
  });
});

describe('initSpriteLocalAnimationHook', () => {
  it('files a job that settles while this process is up', async () => {
    initSpriteLocalAnimationHook();
    mediaJobEvents.emit('completed', walkJob());
    await vi.waitFor(() => expect(attachTuiWalkResult).toHaveBeenCalled());
  });

  it('subscribes to failed and canceled too, not only completed', async () => {
    initSpriteLocalAnimationHook();
    mediaJobEvents.emit('failed', walkJob({ status: 'failed' }));
    await vi.waitFor(() => expect(attachTuiWalkResult).toHaveBeenCalledTimes(1));
    mediaJobEvents.emit('canceled', trackJob({ status: 'canceled' }));
    await vi.waitFor(() => expect(attachTrackTuiResult).toHaveBeenCalledTimes(1));
  });

  it('is idempotent — a double init must not file every clip twice', async () => {
    initSpriteLocalAnimationHook();
    initSpriteLocalAnimationHook();
    mediaJobEvents.emit('completed', walkJob());
    await vi.waitFor(() => expect(attachTuiWalkResult).toHaveBeenCalledTimes(1));
  });

  it('stops listening after reset, so a suite that re-inits does not leak handlers', async () => {
    initSpriteLocalAnimationHook();
    __testing.reset();
    mediaJobEvents.emit('completed', walkJob());
    await Promise.resolve();
    expect(attachTuiWalkResult).not.toHaveBeenCalled();
  });
});

describe('reconcileSettledSpriteJobs (boot pass)', () => {
  it('files jobs that reached a terminal state while the process was DOWN', async () => {
    // These emit nothing — they are simply sitting in the restored archive. The
    // live subscription can never see them, so without this pass the run is only
    // ever resolved by a wall-clock backstop a day later (and never at all on
    // the track lane).
    queuedJobs = [walkJob(), trackJob({ status: 'failed' })];
    expect(await reconcileSettledSpriteJobs()).toBe(2);
    expect(attachTuiWalkResult).toHaveBeenCalled();
    expect(attachTrackTuiResult).toHaveBeenCalled();
  });

  it('leaves still-queued and still-running jobs alone', async () => {
    // Those will emit their own terminal event later; settling them now would
    // file an error over a render that is still going.
    queuedJobs = [walkJob({ status: 'queued' }), trackJob({ status: 'running' })];
    expect(await reconcileSettledSpriteJobs()).toBe(0);
    expect(attachTuiWalkResult).not.toHaveBeenCalled();
    expect(attachTrackTuiResult).not.toHaveBeenCalled();
  });

  it('skips terminal jobs that are not sprite renders', async () => {
    queuedJobs = [{ id: 'x', kind: 'video', status: 'completed', params: { musicVideo: {} } }];
    expect(await reconcileSettledSpriteJobs()).toBe(0);
  });

  it('keeps going when one job throws, rather than abandoning the rest', async () => {
    attachTuiWalkResult.mockRejectedValueOnce(new Error('disk full'));
    queuedJobs = [walkJob(), trackJob()];
    await reconcileSettledSpriteJobs();
    expect(attachTrackTuiResult).toHaveBeenCalled();
  });

  it('runs on init without being awaited by it', async () => {
    queuedJobs = [walkJob()];
    initSpriteLocalAnimationHook();
    await vi.waitFor(() => expect(attachTuiWalkResult).toHaveBeenCalled());
  });
});

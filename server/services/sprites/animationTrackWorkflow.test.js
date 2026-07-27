/**
 * The generic per-track animation workflow (#3136).
 *
 * Replaces `scanner.test.js` + `ambient.test.js`, which asserted the same six
 * behaviors twice against two copies of one control flow. Here every behavior is
 * asserted ONCE, table-driven across both shipped non-walk tracks — which is the
 * property that actually matters now: the module must read the track's registry
 * row rather than branch on its id. A per-track copy of these assertions could
 * pass while the module secretly `if (track === 'ambient')`d its way through.
 *
 * The two rows differ in exactly the ways the registry says they do — a
 * directional track seeded per-facing from its locked anchor vs. a
 * non-directional one seeded from the one locked main — so running one table over
 * both is also the regression test for the fields #3136 introduced.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { lockAllAnchors, placeCandidate } from './spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-track-workflow-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
    images: join(TEST_ROOT, 'images'),
    videos: join(TEST_ROOT, 'videos'),
  });
  return actual;
});

const executeTuiRun = vi.fn(() => new Promise(() => {}));
vi.mock('../../lib/tuiPromptRunner.js', () => ({
  executeTuiRun: (...args) => executeTuiRun(...args),
}));

vi.mock('../settings.js', () => ({
  getSettings: async () => ({ imageGen: { grok: { grokPath: '/usr/local/bin/grok' } } }),
}));

const prepareWalkAnchorChromaInput = vi.fn(async (_sourceAbs, inputAbs) => {
  await mkdir(join(inputAbs, '..'), { recursive: true });
  const bytes = Buffer.from('track-chroma-input');
  await writeFile(inputAbs, bytes);
  return {
    preparation: 'composited-over-solid-chroma-matte',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
});
vi.mock('./walkPostprocess.js', async (importOriginal) => ({
  ...await importOriginal(),
  prepareWalkAnchorChromaInput: (...args) => prepareWalkAnchorChromaInput(...args),
}));

const records = await import('./records.js');
const { lockReference } = await import('./reference.js');
const {
  getTrackState, startTrackGeneration, approveTrackRun, trackAuthoringDirections, trackSetRelPath,
} = await import('./animationTrackWorkflow.js');
const { getAnimationTrack, SCANNER_TRACK, AMBIENT_TRACK } = await import('./animationTracks.js');

let sequence = 0;
const newId = () => `track-${++sequence}`;

// One fixture per SOURCE-REFERENCE shape, not per track: a directional track
// needs a locked anchor for the facing it animates, a non-directional one needs
// the record's single locked main. That is the registry difference under test.
async function characterWithEastAnchor(id) {
  await records.createRecord({ kind: 'character', name: 'Placeholder Hero' }, id);
  await lockAllAnchors(TEST_ROOT, id, { lockReference, directions: ['east'] });
  return id;
}

async function placeWithLockedMain(id) {
  await records.createRecord({ kind: 'place', name: 'Example Willow' }, id);
  const candidate = await placeCandidate(TEST_ROOT, id, 'main', 'main-candidate-01.png');
  await lockReference(id, { target: 'main', candidate });
  return id;
}

// The table every behavior below runs over. `direction` is the facing the
// generate call names (absent for a non-directional track, which derives row 0
// itself) and `promptMarker` is a phrase only THAT track's prompt contains — so a
// module that sent the wrong track's prompt fails here rather than at render time.
const TRACKS = [
  {
    id: SCANNER_TRACK,
    seed: characterWithEastAnchor,
    body: { direction: 'east' },
    expectedDirection: 'east',
    runIdPattern: /^scanner-east-[0-9a-f]{8}$/,
    promptMarker: 'scanner action',
    correction: 'the sweep never returns to the start pose',
    inputName: 'input-anchor-chroma.png',
  },
  {
    id: AMBIENT_TRACK,
    seed: placeWithLockedMain,
    body: {},
    expectedDirection: 'south',
    runIdPattern: /^ambient-[0-9a-f]{8}$/,
    promptMarker: 'ambient loop',
    correction: 'the branches barely move',
    inputName: 'input-main-chroma.png',
  },
];

beforeEach(() => {
  executeTuiRun.mockClear();
  executeTuiRun.mockImplementation(() => new Promise(() => {}));
  prepareWalkAnchorChromaInput.mockClear();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe.each(TRACKS)('the generic workflow drives the $id track', (track) => {
  const row = () => getAnimationTrack(track.id);

  it('is provider-silent on reads, then starts one user-triggered render at the row\'s defaults', async () => {
    const id = await track.seed(newId());

    // The AI-provider policy: reading state must never reach a provider.
    const initial = await getTrackState(track.id, id);
    expect(initial).toMatchObject({
      track: track.id,
      bounds: {
        minFrameCount: row().minFrameCount,
        maxFrameCount: row().maxFrameCount,
        defaultFrameCount: row().defaultFrameCount,
        defaultFps: row().defaultFps,
      },
      selection: null,
      set: null,
      runs: [],
    });
    expect(executeTuiRun).not.toHaveBeenCalled();

    const result = await startTrackGeneration(track.id, id, track.body);
    expect(result).toMatchObject({ duration: 6 });
    expect(result.runId).toMatch(track.runIdPattern);
    expect(result.shellSession).toBe(result.runId);
    expect(executeTuiRun).toHaveBeenCalledOnce();
    const call = executeTuiRun.mock.calls[0][0];
    expect(call).toMatchObject({
      runId: result.runId,
      workspacePath: join(TEST_ROOT, 'sprites', id, 'runs', result.runId, 'generated'),
    });
    // This track's OWN prompt, not a fallback to walk's.
    expect(call.prompt).toContain(track.promptMarker);
    expect(call.prompt).toContain('image_to_video');

    // Defaults come from the row — the whole point of the parameterization.
    expect((await getTrackState(track.id, id)).runs).toMatchObject([{
      id: result.runId,
      track: track.id,
      status: 'rendering',
      frameCount: row().defaultFrameCount,
      fps: row().defaultFps,
      direction: track.expectedDirection,
    }]);
  });

  it('seeds the render from the reference its row names', async () => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, track.body);
    // A directional track prepares its facing's anchor; a non-directional one the
    // single main. Distinguishable by the prepared input's filename, which is
    // also what the run record stamps as provenance.
    const [, inputAbs] = prepareWalkAnchorChromaInput.mock.calls[0];
    expect(inputAbs.endsWith(track.inputName), `${track.id} prepares ${track.inputName}`).toBe(true);
    const { runs } = await getTrackState(track.id, id);
    const run = runs.find((r) => r.id === runId);
    expect(run.animationInputPath).toBe(`runs/${runId}/generated/${track.inputName}`);
    // `anchorPath` names whichever reference seeded it, and is what the approve
    // gate's staleness check re-hashes.
    expect(run.anchorPath).toBeTruthy();
    expect(run.anchorSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('clamps a requested frame count and fps into the row\'s range', async () => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, {
      ...track.body, frameCount: 999, fps: 999,
    });
    const { runs } = await getTrackState(track.id, id);
    expect(runs.find((r) => r.id === runId)).toMatchObject({
      frameCount: row().maxFrameCount,
      fps: row().maxFps,
    });
  });

  it('appends a trimmed correction note to the prompt and stamps it on the run (#3134)', async () => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, {
      ...track.body, correctionPrompt: `  ${track.correction}  `,
    });
    expect(executeTuiRun.mock.calls[0][0].prompt)
      .toContain(`Important correction — apply this over the attached source image: ${track.correction}`);
    const { runs } = await getTrackState(track.id, id);
    expect(runs.find((r) => r.id === runId).correctionPrompt).toBe(track.correction);
  });

  it('leaves a blank correction note out of the prompt and the run record (#3134)', async () => {
    // The task is `<track prompt>\n\n<per-run paths>` — compare the prompt only.
    const trackPrompt = () => executeTuiRun.mock.calls[0][0].prompt.split('\n\n')[0];
    const plain = await track.seed(newId());
    await startTrackGeneration(track.id, plain, track.body);
    const blindPrompt = trackPrompt();
    executeTuiRun.mockClear();

    const blank = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, blank, { ...track.body, correctionPrompt: ' \n ' });
    expect(trackPrompt()).toBe(blindPrompt);
    const { runs } = await getTrackState(track.id, blank);
    expect(runs.find((r) => r.id === runId)).not.toHaveProperty('correctionPrompt');
  });

  it('refuses a second in-flight render for the same target', async () => {
    const id = await track.seed(newId());
    await startTrackGeneration(track.id, id, track.body);
    await expect(startTrackGeneration(track.id, id, track.body))
      .rejects.toMatchObject({ status: 409, code: 'TRACK_RENDER_IN_PROGRESS' });
  });

  it('refuses to generate before the source reference is locked', async () => {
    // A record with NO locked reference at all: the 409 must name the artifact
    // this row asked for, and its code must distinguish the two shapes.
    const id = newId();
    await records.createRecord(
      { kind: row().kinds[0] === 'character' ? 'character' : 'place', name: 'Unlocked' },
      id,
    );
    await expect(startTrackGeneration(track.id, id, track.body)).rejects.toMatchObject({
      status: 409,
      code: row().sourceReference === 'main' ? 'MAIN_NOT_LOCKED' : 'ANCHOR_NOT_LOCKED',
    });
    expect(executeTuiRun).not.toHaveBeenCalled();
  });

  it('refuses to approve a run that was never packaged', async () => {
    const id = await track.seed(newId());
    const { runId } = await startTrackGeneration(track.id, id, track.body);
    await expect(approveTrackRun(track.id, id, { ...track.body, runId }))
      .rejects.toMatchObject({ status: 409, code: 'RUN_NOT_CANDIDATE' });
  });

  it('refuses to approve an unknown run id', async () => {
    const id = await track.seed(newId());
    await expect(approveTrackRun(track.id, id, { ...track.body, runId: 'no-such-run' }))
      .rejects.toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });
  });
});

describe('registry-derived authoring shape (#3136)', () => {
  it('authors a directional track across every facing and a non-directional one across row 0 only', () => {
    // The rule the two clones each hardcoded — `SPRITE_DIRECTIONS.every(...)` in
    // one and "freeze on first approval" in the other — now derived from
    // `directional`, which is what decides when a set is complete.
    expect(trackAuthoringDirections(SCANNER_TRACK)).toHaveLength(8);
    expect(trackAuthoringDirections(SCANNER_TRACK)[0]).toBe('south');
    expect(trackAuthoringDirections(AMBIENT_TRACK)).toEqual(['south']);
  });

  it('keeps each track\'s on-disk set path in the shape its clone wrote', () => {
    // Load-bearing for upgrades: installs already hold approved sets at these
    // exact paths, and the atlas compiler re-verifies the evidence chain by them.
    expect(trackSetRelPath(SCANNER_TRACK, 'pioneer')).toBe('scanner/pioneer-scanner-set-v1.json');
    expect(trackSetRelPath(AMBIENT_TRACK, 'willow')).toBe('ambient/willow-ambient-set-v1.json');
  });

  it('throws for an unregistered track rather than defaulting to walk', async () => {
    // The sentinel rule: a mis-keyed track must not silently author walk state.
    await expect(getTrackState('jetpack', 'pioneer')).rejects.toThrow(/Unknown animation track 'jetpack'/);
  });
});

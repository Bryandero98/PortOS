/**
 * The generic per-track animation workflow (#3136).
 *
 * `scanner.js` and `ambient.js` were two ~300-line copies of one control flow:
 * load the track's review selection / finalized set / runs → require a locked
 * source reference → prepare a chroma matte → start ONE user-requested Grok
 * image-to-video render → package it deterministically → review → approve →
 * freeze the set. Nothing about that sequence is scanner-shaped or ambient
 * shaped; they differed only in three registry facts (#3136 promoted each to a
 * field on the track row):
 *
 *   - `sourceReference`  which locked image seeds the render (`anchor` per
 *                        facing, or the one `main`)
 *   - `directional`      how many facings must be approved before the set freezes
 *   - `selectionKind` / `setKind` / `finalErrorCode`
 *                        the on-disk discriminators and the 409 code
 *
 * plus one prompt builder. So this module is that flow ONCE, parameterized by
 * track id, and a new animation type is a registry row + a prompt — not a fourth
 * copy of this file. Walk deliberately stays on its own service (`walk.js`): it
 * carries reprocess, loop trims, per-direction reopen, source-frame extraction
 * and set-level targets that no other track has, and folding those in would make
 * this module the union of every track's features rather than their intersection.
 *
 * **On-disk compatibility is exact, not approximate.** Every path, `kind`
 * string, run field, error code and message this writes is byte-identical to
 * what the two clones wrote, because installs already hold approved scanner sets
 * and ambient loops whose evidence chain the atlas compiler re-verifies by those
 * exact strings. The clone collapse is a code change only.
 *
 * The render is reachable only through `startTrackGeneration` — a direct user
 * action per the AI-provider policy. Everything after Grok writes the MP4 is
 * deterministic local packing, review, approval, and atlas input; no boot path
 * or read endpoint calls a provider.
 */

import { join } from 'path';
import { readdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { atomicWrite, ensureDir, pathExists, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { executeTuiRun } from '../../lib/tuiPromptRunner.js';
import { GROK_TUI_ID } from '../../lib/grok.js';
import { resolveGrokDuration } from '../../lib/grokVideoClip.js';
import { getSettings } from '../settings.js';
import { getRecord } from './records.js';
import { requireTrack, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS, anchorIdForDirection } from './prompts.js';
import { buildTrackVideoPrompt } from './trackPrompts.js';
import { clampTrackFrameCount, clampTrackFps, getAnimationTrack } from './animationTracks.js';
import { spriteDir, resolveSpriteAssetPath, SOURCE_CLIP_NAME } from './paths.js';
import { prepareWalkAnchorChromaInput, runWalkPostprocess } from './walkPostprocess.js';
import { verifyPackagedFrames } from './walkFrames.js';
import { resolveChromaKey, withAnimationWriteTail } from './animationWorkflow.js';

const RUN_RECORD_NAME = 'animation-run.json';
const TUI_IDLE_MS = 90_000;
const TUI_TIMEOUT_MS = 30 * 60_000;

/**
 * The single atlas row a non-directional track occupies.
 *
 * Row 0 of the grid is `SPRITE_DIRECTIONS[0]`, and `trackDirections()` already
 * slices exactly that entry for a non-directional track — so this reads the
 * facing list rather than restating `'south'`, keeping the authoring side and
 * the compile side derived from one list. The ambient clone hardcoded the
 * literal; the value is identical.
 */
const nonDirectionalRow = () => SPRITE_DIRECTIONS[0];

/**
 * The facings a track is authored across: every direction for a directional
 * track, the single row 0 for a non-directional one. This is the authoring twin
 * of `atlasGrid.trackDirections` — kept here rather than imported because
 * atlasGrid reaches the grid/compile layer, and the authoring side needs only
 * the registry's `directional` flag.
 */
export function trackAuthoringDirections(trackId) {
  const row = getAnimationTrack(trackId);
  return row.directional ? [...SPRITE_DIRECTIONS] : [nonDirectionalRow()];
}

// The on-disk layout, per track. `<track>/` subdirectory and `-<track>-` infix,
// which is exactly what scanner.js and ambient.js each spelled for themselves.
const selectionRelPath = (trackId, id) => `${trackId}/${id}-${trackId}-selection-v1.json`;
export const trackSetRelPath = (trackId, id) => `${trackId}/${id}-${trackId}-set-v1.json`;
const runRelPath = (runId) => `runs/${runId}`;

const setFinalError = (row) => new ServerError(
  row.directional
    ? `${row.label} set is finalized — reopen it before generating or approving another ${row.label.toLowerCase()}`
    : `${row.label} is finalized and immutable`,
  { status: 409, code: row.finalErrorCode },
);

const loadSelection = (trackId, recordId) =>
  readJSONFile(join(spriteDir(recordId), selectionRelPath(trackId, recordId)), null);
const loadSet = (trackId, recordId) =>
  readJSONFile(join(spriteDir(recordId), trackSetRelPath(trackId, recordId)), null);
const loadRun = (recordId, runId) =>
  readJSONFile(join(spriteDir(recordId), runRelPath(runId), RUN_RECORD_NAME), null);

const seedSelection = (row, recordId) => ({
  schemaVersion: 1,
  kind: row.selectionKind,
  track: row.id,
  characterId: recordId,
  status: 'in-progress',
  directions: {},
});

async function saveRun(recordId, run) {
  const dir = join(spriteDir(recordId), runRelPath(run.id));
  await ensureDir(dir);
  await atomicWrite(join(dir, RUN_RECORD_NAME), run);
}

/** Every run on disk belonging to `trackId`, newest first. */
async function trackRuns(trackId, recordId) {
  const runsDir = join(spriteDir(recordId), 'runs');
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => (
    readJSONFile(join(runsDir, entry.name, RUN_RECORD_NAME), null)
  )));
  return runs.filter((run) => run?.track === trackId)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

/**
 * The track's authoring state: `{ track, bounds, selection, set, runs }`.
 *
 * `set` is the generic key. The route layer additionally aliases it to the
 * historical per-track key (`scannerSet` / `ambientSet`) so an existing client
 * keeps reading the field it always did — see `routes/sprites.js`.
 */
export async function getTrackState(trackId, recordId) {
  const row = getAnimationTrack(trackId);
  const [selection, set, runs] = await Promise.all([
    loadSelection(row.id, recordId), loadSet(row.id, recordId), trackRuns(row.id, recordId),
  ]);
  return { track: row.id, bounds: row, selection, set, runs };
}

/**
 * The locked reference image this track's render is seeded from, or null.
 *
 * Two shapes behind one resolver so the caller never branches on
 * `sourceReference`: a directional track reads THIS facing's locked anchor, a
 * non-directional one reads the single locked main. `label` is what the
 * "lock it first" 409 names, so the message points at the artifact the row
 * actually asked for.
 */
function lockedSourceFor(row, manifest, direction) {
  if (row.sourceReference === 'main') {
    const main = manifest?.mainReference;
    return main?.locked && main.path
      ? { path: main.path, sha256: main.sha256 || null, label: 'main reference', inputName: 'input-main-chroma.png' }
      : null;
  }
  const anchor = manifest?.anchors?.find((item) => item.direction === direction);
  return anchor?.status === 'locked' && anchor.path
    ? {
      path: anchor.path,
      sha256: anchor.sha256 || null,
      label: `${anchorIdForDirection(direction)} anchor`,
      inputName: 'input-anchor-chroma.png',
    }
    : null;
}

// The provider task wrapper — identical in both clones, verbatim.
const trackTask = ({ prompt, inputAbs, videoAbs, duration }) => (
  `${prompt}\n\nUse your built-in image_to_video tool to animate this exact image for ${duration} seconds:\n${inputAbs}\n\n`
  + `Save the resulting animation as an MP4 file at exactly this path:\n${videoAbs}\n\n`
  + 'Do not create or modify any other files, and do not run any tools beyond what is needed to render and save that MP4.'
);

export function startTrackGeneration(trackId, recordId, body) {
  return withAnimationWriteTail(recordId, () => startTrackGenerationImpl(trackId, recordId, body));
}

async function startTrackGenerationImpl(trackId, recordId, body) {
  const row = getAnimationTrack(trackId);
  const [record, reference, existingSet, existingRuns] = await Promise.all([
    requireTrack(recordId, row.id), loadManifest(recordId), loadSet(row.id, recordId), trackRuns(row.id, recordId),
  ]);
  if (existingSet) throw setFinalError(row);
  // A non-directional track occupies exactly row 0, so its facing is derived
  // from the registry rather than accepted from the request — no user-supplied
  // direction can drift from what `trackDirections()` will later compile.
  const direction = row.directional ? body.direction : nonDirectionalRow();
  const source = lockedSourceFor(row, reference, direction);
  if (!source) {
    throw new ServerError(
      `Lock the ${source?.label || (row.sourceReference === 'main' ? 'main reference' : `${anchorIdForDirection(direction)} anchor`)} before generating its ${row.label.toLowerCase()}`,
      { status: 409, code: row.sourceReference === 'main' ? 'MAIN_NOT_LOCKED' : 'ANCHOR_NOT_LOCKED' },
    );
  }
  const chromaKey = resolveChromaKey({ manifest: reference, record });
  if (!chromaKey) throw new ServerError('No frozen chroma key is available for this sprite', { status: 409, code: 'CHROMA_KEY_REQUIRED' });
  // In-flight guard, per facing for a directional track and per record for a
  // single-row one (where "another facing" doesn't exist).
  const inFlight = existingRuns.some((run) => (
    ['rendering', 'postprocessing'].includes(run.status) && (!row.directional || run.direction === direction)
  ));
  if (inFlight) {
    throw new ServerError(
      row.directional
        ? `A ${row.label.toLowerCase()} render for ${direction} is already in progress`
        : `A ${row.label.toLowerCase()} render is already in progress`,
      { status: 409, code: 'TRACK_RENDER_IN_PROGRESS' },
    );
  }

  const frameCount = clampTrackFrameCount(body.frameCount, row.id);
  const fps = clampTrackFps(body.fps, row.id);
  // Optional re-roll note (#3134) — blank leaves the prompt and the run record
  // exactly as a blind regenerate would.
  const correctionPrompt = typeof body.correctionPrompt === 'string' ? body.correctionPrompt.trim() : '';
  // Run ids stay in the clones' shapes: `<track>-<direction>-<uuid8>` for a
  // directional track, `<track>-<uuid8>` for a single-row one.
  const runId = row.directional
    ? `${row.id}-${direction}-${randomUUID().slice(0, 8)}`
    : `${row.id}-${randomUUID().slice(0, 8)}`;
  const runRel = runRelPath(runId);
  const generatedAbs = join(spriteDir(recordId), runRel, 'generated');
  await ensureDir(generatedAbs);
  const sourceAbs = resolveSpriteAssetPath(recordId, source.path);
  if (!await pathExists(sourceAbs)) {
    throw new ServerError(
      `Locked ${source.label} file is missing on disk`,
      { status: 500, code: row.sourceReference === 'main' ? 'MAIN_REFERENCE_MISSING' : 'ANCHOR_MISSING' },
    );
  }
  const inputAbs = join(generatedAbs, source.inputName);
  const [{ preparation, sha256: inputSha256 }, settings] = await Promise.all([
    prepareWalkAnchorChromaInput(sourceAbs, inputAbs, chromaKey), getSettings(),
  ]);
  const duration = resolveGrokDuration(body.duration);
  const videoAbs = join(generatedAbs, SOURCE_CLIP_NAME);
  const run = {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    track: row.id,
    provider: GROK_TUI_ID,
    status: 'rendering',
    id: runId,
    shellSession: runId,
    characterId: recordId,
    direction,
    chromaKey,
    duration,
    frameCount,
    fps,
    // `anchorPath`/`anchorSha256` name the SOURCE reference whatever it was —
    // the ambient clone already used these keys for the main reference, and the
    // approve gate's staleness check reads them, so the spelling stays.
    anchorPath: source.path,
    anchorSha256: source.sha256 || await sha256File(sourceAbs),
    animationInputPath: `${runRel}/generated/${source.inputName}`,
    animationInputSha256: inputSha256,
    animationInputPreparation: preparation,
    ...(correctionPrompt ? { correctionPrompt } : {}),
    createdAt: new Date().toISOString(),
  };
  await saveRun(recordId, run);
  runTrackTuiRender(row, recordId, {
    runId,
    direction,
    generatedAbs,
    videoAbs,
    grokPath: settings.imageGen?.grok?.grokPath,
    task: trackTask({
      prompt: buildTrackVideoPrompt(row.id, {
        name: record.name, kind: record.kind, direction, chromaKey, correctionPrompt,
      }),
      inputAbs,
      videoAbs,
      duration,
    }),
  }).catch((err) => console.error(`❌ sprite ${row.id} grok-tui render crashed ${recordId}/${runId}: ${err?.message || err}`));
  console.log(`📡 sprite ${row.id} grok-tui render started ${recordId}/${runId}`);
  return row.directional
    ? { runId, direction, duration, shellSession: runId }
    : { runId, duration, shellSession: runId };
}

async function runTrackTuiRender(row, recordId, { runId, direction, generatedAbs, videoAbs, grokPath, task }) {
  await executeTuiRun({
    runId,
    provider: { id: GROK_TUI_ID, type: 'tui', command: grokPath || 'grok', args: [] },
    prompt: task,
    workspacePath: generatedAbs,
    idleMs: TUI_IDLE_MS,
    timeout: TUI_TIMEOUT_MS,
    label: row.directional ? `sprite ${row.id} ${recordId}/${direction}` : `sprite ${row.id} ${recordId}`,
  }).catch((err) => console.error(`❌ sprite ${row.id} grok-tui run failed ${recordId}/${runId}: ${err?.message || err}`));
  await withAnimationWriteTail(recordId, () => attachTrackTuiResult(row.id, recordId, runId, videoAbs));
}

export async function attachTrackTuiResult(trackId, recordId, runId, videoAbs) {
  const row = getAnimationTrack(trackId);
  const run = await loadRun(recordId, runId);
  if (!run || run.track !== row.id || await loadSet(row.id, recordId)) return;
  const selection = await loadSelection(row.id, recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) return;
  if (!await pathExists(videoAbs)) {
    run.status = 'error';
    run.postprocessError = `Grok finished without writing the ${row.label.toLowerCase()} video — check the shell session output`;
    run.completedAt = new Date().toISOString();
    await saveRun(recordId, run);
    return;
  }
  run.status = 'postprocessing';
  run.sourceVideoPath = `${runRelPath(run.id)}/generated/${SOURCE_CLIP_NAME}`;
  await saveRun(recordId, run);
  await packageTrackRun(row, recordId, run);
  await saveRun(recordId, run);
}

async function packageTrackRun(row, recordId, run) {
  // Runs outside the request lifecycle (the TUI completion tail), so a throw
  // here would take the process down rather than reaching error middleware —
  // hence the try/catch, per the CLAUDE.md boundary exception.
  try {
    const [reference, record] = await Promise.all([loadManifest(recordId), getRecord(recordId)]);
    const source = lockedSourceFor(row, reference, run.direction);
    if (!source) throw new Error(`No locked ${row.sourceReference === 'main' ? 'main reference' : `${run.direction} anchor`} in the reference manifest`);
    const chromaKey = resolveChromaKey({ manifest: reference, record, run });
    if (!chromaKey) throw new Error(`No chroma key is available for the ${row.label.toLowerCase()} matte`);
    const runRel = runRelPath(run.id);
    const result = await runWalkPostprocess({
      recordId,
      track: row.id,
      direction: run.direction,
      chromaKey,
      runAbs: join(spriteDir(recordId), runRel),
      runRel,
      anchorRel: source.path,
      anchorAbs: resolveSpriteAssetPath(recordId, source.path),
      videoAbs: resolveSpriteAssetPath(recordId, run.sourceVideoPath),
      frameCount: clampTrackFrameCount(run.frameCount, row.id),
      fps: clampTrackFps(run.fps, row.id),
    });
    run.frameCount = result.manifest.frameCount;
    run.fps = result.manifest.frameRate;
    run.status = 'candidate';
    run.postprocessManifest = result.manifestPath;
    run.stripPreview = result.stripPreview;
    delete run.postprocessError;
  } catch (err) {
    run.status = 'error';
    run.postprocessError = err.message;
    console.error(`❌ sprite ${row.id} postprocess failed ${recordId}/${run.id}: ${err.message}`);
  }
  run.completedAt = new Date().toISOString();
}

export function approveTrackRun(trackId, recordId, args) {
  return withAnimationWriteTail(recordId, () => approveTrackRunImpl(trackId, recordId, args));
}

async function approveTrackRunImpl(trackId, recordId, { direction: requested, runId }) {
  const row = getAnimationTrack(trackId);
  await requireTrack(recordId, row.id);
  if (await loadSet(row.id, recordId)) throw setFinalError(row);
  const direction = row.directional ? requested : nonDirectionalRow();
  const label = row.label.toLowerCase();
  const run = await loadRun(recordId, runId);
  if (!run || run.track !== row.id) throw new ServerError(`Unknown ${label} run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  if (run.direction !== direction) throw new ServerError(`Run ${runId} animates '${run.direction}', not '${direction}'`, { status: 400, code: 'RUN_DIRECTION_MISMATCH' });
  if (run.status !== 'candidate' || !run.postprocessManifest) throw new ServerError('Run has no packaged candidate to approve', { status: 409, code: 'RUN_NOT_CANDIDATE' });
  const [reference, packaged] = await Promise.all([
    loadManifest(recordId), readJSONFile(resolveSpriteAssetPath(recordId, run.postprocessManifest), null),
  ]);
  const source = lockedSourceFor(row, reference, direction);
  if (!source) {
    throw new ServerError(
      `Lock the ${row.sourceReference === 'main' ? 'main reference' : `${anchorIdForDirection(direction)} anchor`} before approving its ${label}`,
      { status: 409, code: row.sourceReference === 'main' ? 'MAIN_NOT_LOCKED' : 'ANCHOR_NOT_LOCKED' },
    );
  }
  if (run.anchorSha256) {
    const currentSha256 = source.sha256 || await sha256File(resolveSpriteAssetPath(recordId, source.path));
    if (run.anchorSha256 !== currentSha256) {
      throw new ServerError(
        `This ${label} was rendered from an older ${source.label} — generate it again from the current reference`,
        { status: 409, code: 'RUN_ANCHOR_STALE' },
      );
    }
  }
  if (!packaged || packaged.track !== row.id || packaged.direction !== direction || packaged.characterId !== recordId
    || packaged.frameCount !== run.frameCount || packaged.frameRate !== run.fps) {
    throw new ServerError(`Packaged ${label} manifest is missing or inconsistent`, { status: 409, code: 'RUN_MANIFEST_INVALID' });
  }
  const frameCheck = await verifyPackagedFrames(recordId, packaged, { track: row.id });
  if (frameCheck.missing) throw new ServerError(
    `${frameCheck.missing} of this ${label} run's ${frameCheck.total} packaged frames are missing on disk`,
    { status: 409, code: 'RUN_FRAMES_MISSING' },
  );
  const selection = (await loadSelection(row.id, recordId)) || seedSelection(row, recordId);
  selection.directions[direction] = {
    status: 'approved',
    runId,
    runPath: runRelPath(runId),
    runManifest: run.postprocessManifest,
    runManifestSha256: await sha256File(resolveSpriteAssetPath(recordId, run.postprocessManifest)),
    approvedAt: new Date().toISOString(),
  };
  // How many facings must land before the set freezes is registry data, so a
  // single-row track freezes on its first approval and a directional one on its
  // eighth — the two clones' `allApproved` rules, unified.
  const authoringDirections = trackAuthoringDirections(row.id);
  const allApproved = authoringDirections.every((item) => selection.directions[item]?.status === 'approved');
  selection.status = allApproved ? 'complete' : 'in-progress';
  const selectionAbs = join(spriteDir(recordId), selectionRelPath(row.id, recordId));
  await ensureDir(join(spriteDir(recordId), row.id));
  await atomicWrite(selectionAbs, selection);
  if (allApproved) {
    await atomicWrite(join(spriteDir(recordId), trackSetRelPath(row.id, recordId)), {
      schemaVersion: 1,
      kind: row.setKind,
      track: row.id,
      characterId: recordId,
      status: 'final',
      directionOrder: authoringDirections,
      selectionPath: selectionRelPath(row.id, recordId),
      selectionSha256: await sha256File(selectionAbs),
      directions: selection.directions,
      finalizedAt: new Date().toISOString(),
    });
    console.log(`🏁 sprite ${row.id} set finalized for ${recordId}`);
  }
  return getTrackState(row.id, recordId);
}

/**
 * Drop one facing's approval because the reference it was rendered from changed.
 *
 * Called from the reference-unlock paths in `walk.js`: a revised anchor or a
 * regenerated turnaround must not leave a stale approved clip standing, since
 * the atlas would then compile frames drawn from an image that no longer exists.
 * Returns true when something was actually invalidated.
 */
export function invalidateTrackDirectionForAnchorRevision(trackId, recordId, { direction }) {
  return withAnimationWriteTail(recordId, () => invalidateTrackDirectionImpl(trackId, recordId, direction));
}

/** Every facing of `trackId`, for a turnaround revision that resets them all. */
export function invalidateTrackForTurnaroundRevision(trackId, recordId) {
  return withAnimationWriteTail(recordId, async () => {
    const invalidated = [];
    for (const direction of trackAuthoringDirections(trackId)) {
      // eslint-disable-next-line no-await-in-loop -- ordered: each facing's selection write must settle before the next reads it
      if (await invalidateTrackDirectionImpl(trackId, recordId, direction)) invalidated.push(direction);
    }
    return invalidated;
  });
}

async function invalidateTrackDirectionImpl(trackId, recordId, direction) {
  const row = getAnimationTrack(trackId);
  const [finalizedSet, loaded] = await Promise.all([loadSet(row.id, recordId), loadSelection(row.id, recordId)]);
  const approved = loaded?.directions?.[direction] || finalizedSet?.directions?.[direction];
  if (approved?.status !== 'approved') return false;
  const selection = loaded || { ...seedSelection(row, recordId), directions: { ...(finalizedSet?.directions || {}) } };
  if (finalizedSet) await rm(join(spriteDir(recordId), trackSetRelPath(row.id, recordId)), { force: true });
  delete selection.directions[direction];
  selection.status = 'in-progress';
  await ensureDir(join(spriteDir(recordId), row.id));
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(row.id, recordId)), selection);
  const run = approved.runId ? await loadRun(recordId, approved.runId) : null;
  if (run?.track === row.id) {
    await saveRun(recordId, {
      ...run,
      status: 'superseded-anchor',
      supersededAt: new Date().toISOString(),
      supersededReason: 'directional-anchor-revised',
    });
  }
  console.log(`♻️ sprite ${row.id} direction ${recordId}/${direction} invalidated after anchor revision`);
  return true;
}

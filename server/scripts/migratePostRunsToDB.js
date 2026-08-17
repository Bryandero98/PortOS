/**
 * One-time POST history importer (#4441): scored sessions + training entries
 * from their legacy JSON files into normalized PostgreSQL runs/attempts.
 *
 * Rows use stable legacy-derived ids and ON CONFLICT upserts, so a crash before
 * the marker/rename is safe to retry. Source files are renamed only after one
 * transaction has imported both feeds successfully.
 */

import { rename, stat } from 'fs/promises';
import { join } from 'path';
import { PATHS, readJSONFile } from '../lib/fileUtils.js';
import { markerExists, writeMarker } from '../lib/migrationMarker.js';
import { mirrorTimestamp } from '../lib/pgTimestamp.js';
import { withTransaction } from '../lib/db.js';
import { saveNormalizedRunWithClient } from '../services/postRunDb.js';

const MARKER = 'post-runs.migrated.json';
const SESSIONS = 'post-sessions.json';
const TRAINING = 'post-training-log.json';

const validDay = (value, fallback) => {
  const candidate = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    const parsed = new Date(`${candidate}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate) return candidate;
  }
  return fallback.slice(0, 10);
};
const bounded = (value, min, max, fallback = null) => {
  if (value == null || value === '' || typeof value === 'boolean') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

async function parkLegacyFile(path) {
  const source = await stat(path).catch(() => null);
  if (!source) return false;
  const recoveryPath = `${path}.imported`;
  const recovery = await stat(recoveryPath).catch(() => null);
  if (recovery) return false; // retain the existing recovery copy
  await rename(path, recoveryPath);
  return true;
}

export function normalizeLegacyPostSession(session, index, now) {
  const id = typeof session?.id === 'string' && session.id ? session.id : `legacy-post-session:${index}`;
  const startedAt = mirrorTimestamp(session?.startedAt, mirrorTimestamp(session?.completedAt, now));
  const completedAt = mirrorTimestamp(session?.completedAt, startedAt);
  const tasks = Array.isArray(session?.tasks) ? session.tasks : [];
  const data = { ...(session || {}), id, legacy: true };
  return {
    id,
    mode: 'test',
    localDay: validDay(session?.date, startedAt),
    startedAt,
    completedAt,
    status: 'completed',
    planned: { cadence: session?.cadence || 'daily', modules: session?.modules || [] },
    data,
    legacy: true,
    attempts: tasks.map((task, position) => {
      const questions = Array.isArray(task?.questions) ? task.questions : [];
      const answered = questions.filter((question) => question?.answered != null);
      return {
        id: task?.id || `${id}:attempt:${position}`,
        module: task?.module || 'unknown',
        drillType: task?.type || 'unknown',
        difficulty: task?.config || null,
        configVersion: task?.configVersion || 'legacy',
        correct: answered.length ? answered.every((question) => question?.correct === true) : null,
        score: bounded(task?.score, 0, 100),
        latencyMs: bounded(task?.totalMs, 0, Number.MAX_SAFE_INTEGER, 0),
        completion: typeof task?.completion === 'number'
          ? bounded(task.completion, 0, 1)
          : questions.length ? answered.length / questions.length : null,
        hintUsed: questions.some((question) => question?.hintUsed === true),
        confidence: null,
        inputMode: task?.inputMode || 'unknown',
        scorerProvenance: task?.scorerProvenance || 'legacy',
        data: { ...(task || {}), legacy: true, inputMode: task?.inputMode || 'unknown', scorerProvenance: task?.scorerProvenance || 'legacy' },
        legacy: true,
      };
    }),
  };
}

export function normalizeLegacyTrainingEntry(entry, index, now) {
  const attemptId = typeof entry?.id === 'string' && entry.id ? entry.id : `legacy-training-attempt:${index}`;
  const id = typeof entry?.runId === 'string' && entry.runId ? entry.runId : `legacy-training-run:${attemptId}`;
  const startedAt = mirrorTimestamp(entry?.timestamp, now);
  const total = Number(entry?.questionCount ?? entry?.total) || 0;
  const correctCount = Number(entry?.correctCount ?? entry?.correct) || 0;
  const data = {
    ...(entry || {}), id: attemptId, runId: id, legacy: true,
    inputMode: entry?.inputMode || 'unknown',
    scorerProvenance: entry?.scorerProvenance || 'legacy',
  };
  return {
    id,
    mode: 'training',
    localDay: validDay(entry?.date, startedAt),
    startedAt,
    completedAt: startedAt,
    status: 'completed',
    planned: { modules: entry?.module ? [entry.module] : [] },
    data: { id, mode: 'training', legacy: true },
    legacy: true,
    attempts: [{
      id: attemptId,
      module: entry?.module || (entry?.memoryItemId ? 'memory' : 'unknown'),
      drillType: entry?.drillType || entry?.mode || 'unknown',
      difficulty: entry?.difficulty || null,
      configVersion: entry?.configVersion || 'legacy',
      correct: total > 0 ? correctCount === total : null,
      score: bounded(entry?.score, 0, 100, total > 0 ? bounded((correctCount / total) * 100, 0, 100) : null),
      latencyMs: bounded(entry?.totalMs, 0, Number.MAX_SAFE_INTEGER, 0),
      completion: total > 0 ? 1 : null,
      hintUsed: entry?.hintUsed === true,
      confidence: bounded(entry?.confidence, 0, 1),
      inputMode: entry?.inputMode || 'unknown',
      scorerProvenance: entry?.scorerProvenance || 'legacy',
      data,
      legacy: true,
    }],
  };
}

export function groupLegacyTrainingRuns(entries, now) {
  const grouped = new Map();
  entries.forEach((entry, index) => {
    const candidate = normalizeLegacyTrainingEntry(entry, index, now);
    const existing = grouped.get(candidate.id);
    if (!existing) {
      grouped.set(candidate.id, candidate);
      return;
    }
    existing.attempts.push(...candidate.attempts);
    if (candidate.startedAt < existing.startedAt) {
      existing.startedAt = candidate.startedAt;
      existing.localDay = candidate.localDay;
    }
    if (candidate.completedAt > existing.completedAt) existing.completedAt = candidate.completedAt;
    existing.planned.modules = [...new Set([
      ...(existing.planned.modules || []),
      ...(candidate.planned.modules || []),
    ])];
  });
  return [...grouped.values()];
}

export async function migratePostRunsToDB() {
  if (await markerExists(MARKER)) return { ok: true, reason: 'already-applied', runs: 0, attempts: 0 };

  const sessionsPath = join(PATHS.meatspace, SESSIONS);
  const trainingPath = join(PATHS.meatspace, TRAINING);
  const [sessionsStat, trainingStat] = await Promise.all([
    stat(sessionsPath).catch(() => null),
    stat(trainingPath).catch(() => null),
  ]);
  if (!sessionsStat && !trainingStat) return { ok: true, reason: 'fresh-install', runs: 0, attempts: 0 };

  const sessionsData = sessionsStat
    ? await readJSONFile(sessionsPath, null, { allowArray: false, strict: true })
    : { sessions: [] };
  const trainingData = trainingStat
    ? await readJSONFile(trainingPath, null, { allowArray: false, strict: true })
    : { entries: [] };
  if (!Array.isArray(sessionsData?.sessions)) throw new Error('Legacy POST sessions file is malformed');
  if (!Array.isArray(trainingData?.entries)) throw new Error('Legacy POST training log is malformed');

  const now = new Date().toISOString();
  const runs = [
    ...sessionsData.sessions.map((session, index) => normalizeLegacyPostSession(session, index, now)),
    ...groupLegacyTrainingRuns(trainingData.entries, now),
  ];
  await withTransaction(async (client) => {
    for (const run of runs) await saveNormalizedRunWithClient(client, run);
  });

  const renamed = [];
  try {
    if (sessionsStat && await parkLegacyFile(sessionsPath)) renamed.push(SESSIONS);
    if (trainingStat && await parkLegacyFile(trainingPath)) renamed.push(TRAINING);
  } catch (err) {
    console.warn(`⚠️ POST→DB import landed but legacy-file rename failed (${err.message}); next boot will retry idempotently`);
    return { ok: true, reason: 'imported-rename-failed', runs: runs.length, attempts: runs.reduce((sum, run) => sum + run.attempts.length, 0) };
  }

  const attempts = runs.reduce((sum, run) => sum + run.attempts.length, 0);
  await writeMarker(MARKER, { migratedAt: new Date().toISOString(), runs: runs.length, attempts, renamed });
  console.log(`🧪 POST→DB import: ${runs.length} run(s), ${attempts} attempt(s); legacy recovery copies retained`);
  return { ok: true, reason: 'imported', runs: runs.length, attempts };
}

/**
 * POST Training Log Service
 *
 * Tracks practice sessions separate from scored POST history.
 * Training mode: progressive difficulty, hints, immediate feedback.
 */

import { randomUUID } from 'crypto';
import { getUserTimezone, todayInTimezone, userLocalToday } from '../lib/timezone.js';
import { recordDayKey, ymdShift } from '../lib/postStreak.js';
import { getUnifiedActivityStreak } from './postActivityStreak.js';
import { getAllTrainingEntries } from './postTrainingLogStore.js';
import { saveStoredTrainingRun } from './postRunStore.js';

export { getAllTrainingEntries };

function trainingAttempt(runId, attempt, position, localDay, startedAt) {
  const questionCount = attempt.questionCount ?? attempt.questions?.length ?? 0;
  const correctCount = attempt.correctCount
    ?? attempt.questions?.filter((question) => question?.correct === true).length
    ?? 0;
  const score = attempt.score !== undefined
    ? attempt.score
    : (questionCount > 0 ? (correctCount / questionCount) * 100 : null);
  const id = attempt.id || `${runId}:attempt:${position}`;
  const record = {
    id,
    runId,
    date: localDay,
    timestamp: startedAt,
    module: attempt.module,
    drillType: attempt.drillType,
    ...(attempt.memoryItemId ? { memoryItemId: attempt.memoryItemId } : {}),
    questionCount,
    correctCount,
    totalMs: attempt.latencyMs ?? attempt.totalMs ?? 0,
    ...(Array.isArray(attempt.questions) ? { questions: attempt.questions } : {}),
    difficulty: attempt.difficulty !== undefined ? attempt.difficulty : (attempt.config ?? null),
    configVersion: attempt.configVersion || null,
    correct: attempt.correct !== undefined ? attempt.correct : (questionCount > 0 ? correctCount === questionCount : null),
    score,
    completion: attempt.completion !== undefined ? attempt.completion : (questionCount > 0 ? 1 : null),
    hintUsed: attempt.hintUsed === true,
    confidence: attempt.confidence ?? null,
    inputMode: attempt.inputMode || 'unknown',
    scorerProvenance: attempt.scorerProvenance || 'post-client',
  };
  return {
    id,
    module: record.module,
    drillType: record.drillType,
    difficulty: record.difficulty,
    configVersion: record.configVersion,
    correct: record.correct,
    score: record.score,
    latencyMs: record.totalMs,
    completion: record.completion,
    hintUsed: record.hintUsed,
    confidence: record.confidence,
    inputMode: record.inputMode,
    scorerProvenance: record.scorerProvenance,
    data: record,
  };
}

/** Atomically save a complete training run. Stable ids make retries idempotent. */
export async function submitTrainingRun(input) {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const startedAt = input.startedAt || now;
  const completedAt = input.completedAt || now;
  const localDay = await userLocalToday(new Date(startedAt));
  const run = {
    id: input.id,
    mode: 'training',
    localDay,
    startedAt,
    completedAt,
    status: 'completed',
    planned: input.planned || {
      modules: [...new Set(input.attempts.map((attempt) => attempt.module))],
      drillTypes: input.attempts.map((attempt) => attempt.drillType),
    },
    data: { id: input.id, mode: 'training', localDay, startedAt, completedAt },
    attempts: input.attempts.map((attempt, position) => trainingAttempt(input.id, attempt, position, localDay, startedAt)),
  };
  const saved = await saveStoredTrainingRun(run);
  // Training is skill evidence, so a newly-saved run also reconciles the same
  // mastered-skill retention schedule as a scored session. Keep this AFTER the
  // atomic run transaction and gate it to first insert: a dropped-response retry
  // must not advance/reset retention twice. As with scored-session bookkeeping,
  // a secondary schedule failure cannot turn a durable save into a false 500.
  if (saved.isNew) {
    try {
      const { syncReviewScheduleForSession } = await import('./meatspacePost.js');
      await syncReviewScheduleForSession({
        tasks: saved.run.attempts.map((attempt) => ({
          ...(attempt.data || {}),
          module: attempt.module,
          type: attempt.drillType,
          config: attempt.difficulty || {},
          questions: attempt.data?.questions || [],
          score: attempt.score,
          accuracy: attempt.data?.questionCount > 0
            ? attempt.data.correctCount / attempt.data.questionCount
            : null,
          completion: attempt.completion,
        })),
      }, new Date(saved.run.completedAt || now));
    } catch (err) {
      console.error(`❌ POST training retention sync failed (run ${run.id} still saved): ${err.message}`);
    }
  }
  console.log(`🏋️ Training run ${saved.isNew ? 'saved' : 'updated'}: ${run.attempts.length} attempt(s)`);
  return {
    id: saved.run.id,
    mode: 'training',
    localDay: saved.run.localDay,
    startedAt: saved.run.startedAt,
    completedAt: saved.run.completedAt,
    attemptCount: saved.run.attempts.length,
    attempts: saved.run.attempts.map((attempt) => attempt.data),
  };
}

/**
 * Submit a training practice entry after a training-mode drill completes.
 */
export async function submitTrainingEntry(entry) {
  const runId = entry.runId || (entry.id ? `training-entry:${entry.id}` : randomUUID());
  const result = await submitTrainingRun({
    id: runId,
    attempts: [{ ...entry, id: entry.id || randomUUID(), latencyMs: entry.totalMs }],
  });
  const record = result.attempts[0];
  console.log(`🏋️ Training logged: ${record.module}/${record.drillType} ${record.correctCount}/${record.questionCount}`);
  return record;
}

/**
 * Get training stats: per-drill practice counts, streaks, recent activity.
 *
 * The streak comes from the SHARED unified streak (`getUnifiedActivityStreak` in
 * postActivityStreak.js) — the exact same number the launcher, dashboard widgets,
 * and Progress page show — so the Morse trainer can no longer disagree with them
 * (issue #2091). It counts BOTH scored sessions and training-log entries over
 * ALL history; only the per-drill breakdown below is windowed.
 */
export async function getTrainingStats(days = 30) {
  const atDate = new Date();
  const allEntries = await getAllTrainingEntries();
  const timezone = await getUserTimezone();
  const todayStr = todayInTimezone(timezone, atDate);

  let entries = allEntries;
  if (days > 0) {
    // Window off the user's local today (DST-safe day math) so the cutoff matches
    // the local-day strings the training/practice writers now stamp (issue #2681);
    // a UTC-day cutoff would clip the oldest local day or admit an extra one.
    const cutoffStr = ymdShift(todayStr, -days);
    entries = allEntries.filter(e => {
      const date = recordDayKey(e, timezone);
      return date && date >= cutoffStr;
    });
  }

  // Group by drill type (windowed)
  const byDrill = {};
  for (const e of entries) {
    const key = `${e.module}:${e.drillType}`;
    if (!byDrill[key]) byDrill[key] = { practiceCount: 0, totalCorrect: 0, totalQuestions: 0, totalMs: 0, dates: new Set() };
    byDrill[key].practiceCount++;
    byDrill[key].totalCorrect += e.correctCount || 0;
    byDrill[key].totalQuestions += e.questionCount || 0;
    byDrill[key].totalMs += e.totalMs || 0;
    const date = recordDayKey(e, timezone);
    if (date) byDrill[key].dates.add(date);
  }

  // ONE unified streak across sessions + training (shared helper, ALL history).
  // Pass allEntries (already loaded above) rather than re-fetching via
  // getAllTrainingEntries() — postActivityStreak.js takes training as a
  // parameter specifically so it doesn't need to import this module.
  const { current: currentStreak, longest: longestStreak } = await getUnifiedActivityStreak(allEntries, todayStr, timezone);
  const activeDays = new Set(entries.map(e => recordDayKey(e, timezone)).filter(Boolean)).size;

  // Summarize
  const summary = {};
  for (const [key, stats] of Object.entries(byDrill)) {
    summary[key] = {
      practiceCount: stats.practiceCount,
      accuracy: stats.totalQuestions > 0 ? Math.round((stats.totalCorrect / stats.totalQuestions) * 100) : 0,
      totalMs: stats.totalMs,
      daysActive: stats.dates.size,
    };
  }

  return {
    days,
    activeDays,
    totalEntries: entries.length,
    currentStreak,
    longestStreak,
    byDrill: summary,
  };
}

/**
 * Get recent training entries for display. Reads through
 * `getAllTrainingEntries`, so each entry's `date` is re-derived in the user's
 * current timezone (#4168) and the history list agrees with the streak/stats
 * that are computed off the same day keys.
 */
export async function getTrainingEntries(limit = 20) {
  const entries = await getAllTrainingEntries();
  if (!limit) return entries.slice().reverse();
  return entries.slice(-limit).reverse();
}

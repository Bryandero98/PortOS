import { describe, it, expect } from 'vitest';
import {
  summarizePostEngagement,
  summarizeCreativeFeedback,
  buildProductActions,
  toProductMetricsAggregate,
} from './portosProductMetrics.js';

const timezone = 'UTC';
const today = '2026-08-24';

describe('summarizePostEngagement', () => {
  it('combines scored and training activity without losing feature-specific counts', () => {
    const result = summarizePostEngagement({
      timezone,
      today,
      sessions: [{ startedAt: '2026-08-23T12:00:00.000Z', date: '2026-08-23' }],
      trainingEntries: [{ timestamp: '2026-08-22T12:00:00.000Z', date: '2026-08-22' }],
    });

    expect(result).toMatchObject({
      status: 'ok',
      completedToday: false,
      lastActiveDate: '2026-08-23',
      daysSinceActivity: 1,
      currentStreak: 2,
      activeDaysLast7: 2,
      scoredSessionsLast7: 1,
      trainingEntriesLast7: 1,
    });
  });

  it('counts training as today activity and returns an explicit invalid-day sentinel', () => {
    expect(summarizePostEngagement({ timezone, today, sessions: [], trainingEntries: [
      { date: today, timestamp: `${today}T08:00:00.000Z` },
    ] }).completedToday).toBe(true);
    expect(summarizePostEngagement({ timezone, today: null })).toEqual({
      status: 'unavailable',
      reason: 'missing-local-day',
    });
  });
});

describe('summarizeCreativeFeedback', () => {
  it('counts only completed successful projects and leaves unrated renders actionable', () => {
    const result = summarizeCreativeFeedback({
      now: new Date(`${today}T12:00:00.000Z`),
      commissions: [{
        id: 'commission-example',
        name: 'Example Nightly Commission',
        runs: [
          { id: 'run-old', projectId: 'project-old', ranAt: '2026-08-20T02:00:00.000Z', status: 'started' },
          { id: 'run-rated', projectId: 'project-rated', ranAt: '2026-08-23T02:00:00.000Z', status: 'started' },
          { id: 'run-future', projectId: 'project-future', ranAt: '2026-08-25T02:00:00.000Z', status: 'started' },
          { id: 'run-failed', projectId: 'project-failed', ranAt: '2026-08-22T02:00:00.000Z', status: 'failed' },
          { id: 'run-active', projectId: 'project-active', ranAt: '2026-08-21T02:00:00.000Z', status: 'started' },
        ],
        feedback: [{ runId: 'run-rated', rating: 'up', at: '2026-08-23T10:00:00.000Z' }],
      }],
      projects: [
        { id: 'project-old', status: 'complete' },
        { id: 'project-rated', status: 'complete' },
        { id: 'project-future', status: 'complete' },
        { id: 'project-failed', status: 'complete' },
        { id: 'project-active', status: 'rendering' },
      ],
    });

    expect(result).toMatchObject({
      status: 'ok',
      configuredCount: 1,
      completedRenders: 2,
      reviewedRenders: 1,
      unreviewedRenders: 1,
      oldestUnreviewedAgeDays: 4,
      feedbackCoveragePercent: 50,
    });
    expect(result.pendingReviews[0]).toMatchObject({
      commissionId: 'commission-example',
      runId: 'run-old',
      commissionName: 'Example Nightly Commission',
    });
  });
});

describe('buildProductActions', () => {
  it('creates deep-linked POST and feedback actions from current gaps', () => {
    const actions = buildProductActions({
      post: {
        status: 'ok', completedToday: false, daysSinceActivity: 3,
        activeDaysLast7: 2, currentStreak: 1,
      },
      creativeCommissions: {
        status: 'ok', unreviewedRenders: 1, oldestUnreviewedAgeDays: 4,
        feedbackCoveragePercent: 0,
        pendingReviews: [{ commissionId: 'commission-example', commissionName: 'Example', runId: 'run-old' }],
      },
    });

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: 'post_engagement', severity: 'high', link: '/post/launcher' });
    expect(actions[1]).toMatchObject({
      type: 'commission_feedback',
      severity: 'high',
      link: '/creative-commission/commission-example?run=run-old',
    });
  });

  it('does not create actions from unavailable metrics', () => {
    expect(buildProductActions({
      post: { status: 'unavailable' },
      creativeCommissions: { status: 'unavailable' },
    })).toEqual([]);
  });
});

describe('toProductMetricsAggregate', () => {
  it('keeps user-facing action details out of the Layered Intelligence payload', () => {
    const result = toProductMetricsAggregate({
      today,
      post: { status: 'ok', completedToday: false },
      creativeCommissions: {
        status: 'ok',
        unreviewedRenders: 1,
        pendingReviews: [{ commissionName: 'Example Commission', commissionId: 'commission-example', runId: 'run-example' }],
      },
      actions: [{ title: 'Creative feedback overdue: Example Commission', link: '/creative-commission/commission-example' }],
    });

    expect(result).toEqual({
      today,
      post: { status: 'ok', completedToday: false },
      creativeCommissions: { status: 'ok', unreviewedRenders: 1 },
    });
  });
});

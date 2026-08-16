import { describe, it, expect } from 'vitest';
import { computeFilterResult } from './cityFilter.js';

const apps = [
  { id: 'a', name: 'Alpha', tags: ['prod'], archived: false, overallStatus: 'online', pm2Status: {} },
  { id: 'b', name: 'Beta', tags: [], archived: false, overallStatus: 'stopped', pm2Status: {} },
  { id: 'c', name: 'Gamma', tags: ['ops'], archived: false, overallStatus: 'online', pm2Status: { web: { status: 'errored' } } },
  { id: 'd', name: 'Delta', tags: [], archived: true, overallStatus: 'online', pm2Status: {} },
];

describe('computeFilterResult', () => {
  it('returns every app as a match for status=all with no search', () => {
    const { matches, dimmed } = computeFilterResult({ apps, status: 'all', search: '' });
    expect(matches.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(dimmed.size).toBe(0);
  });

  it('excludes archived apps from online/stopped/errored', () => {
    // `online` is overallStatus; an app can also match `errored` via pm2.
    expect(computeFilterResult({ apps, status: 'online' }).matches.map((a) => a.id)).toEqual(['a', 'c']);
    expect(computeFilterResult({ apps, status: 'stopped' }).matches.map((a) => a.id)).toEqual(['b']);
    expect(computeFilterResult({ apps, status: 'errored' }).matches.map((a) => a.id)).toEqual(['c']);
  });

  it('filters by name, id, or tag and puts the rest in dimmed', () => {
    const byName = computeFilterResult({ apps, status: 'all', search: 'alp' });
    expect(byName.matches.map((a) => a.id)).toEqual(['a']);
    expect([...byName.dimmed]).toEqual(['b', 'c', 'd']);

    const byTag = computeFilterResult({ apps, status: 'all', search: 'ops' });
    expect(byTag.matches.map((a) => a.id)).toEqual(['c']);
  });

  it('restricts the agent filter to ids present in agentMap', () => {
    const agentMap = new Set(['b']);
    const { matches, dimmed } = computeFilterResult({ apps, status: 'agent', agentMap });
    expect(matches.map((a) => a.id)).toEqual(['b']);
    expect(dimmed.has('a')).toBe(true);
  });
});

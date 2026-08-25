import { describe, it, expect } from 'vitest';
import { APP_DETAIL_TABS, appUsesJira } from './constants';

const visibleIds = (app) =>
  APP_DETAIL_TABS.filter(t => (t.visibleWhen ? t.visibleWhen(app) : true)).map(t => t.id);

describe('appUsesJira', () => {
  it('is false for an app with no JIRA config at all', () => {
    expect(appUsesJira({ id: 'a', workTracker: 'auto' })).toBe(false);
    expect(appUsesJira({ id: 'a' })).toBe(false);
    expect(appUsesJira(null)).toBe(false);
  });

  it('is true once the integration is enabled', () => {
    expect(appUsesJira({ jira: { enabled: true } })).toBe(true);
  });

  it('is true when JIRA is the chosen work tracker, before any integration config exists', () => {
    // The bootstrap path: the JIRA tab hosts its own config panel, so this is
    // what makes the tab reachable for a never-configured app.
    expect(appUsesJira({ workTracker: 'jira' })).toBe(true);
  });

  it('is false for a disabled integration left behind by a previous setup', () => {
    expect(appUsesJira({ workTracker: 'github', jira: { enabled: false, projectKey: 'PROJ' } })).toBe(false);
  });
});

describe('APP_DETAIL_TABS jira visibility', () => {
  it('hides the JIRA tab for an app that is not wired to JIRA', () => {
    expect(visibleIds({ id: 'a', workTracker: 'github' })).not.toContain('jira');
  });

  it('shows the JIRA tab when the integration is enabled', () => {
    expect(visibleIds({ id: 'a', jira: { enabled: true } })).toContain('jira');
  });

  it('shows the JIRA tab when JIRA is the work tracker', () => {
    expect(visibleIds({ id: 'a', workTracker: 'jira' })).toContain('jira');
  });

  it('leaves the unconditional tabs alone', () => {
    const ids = visibleIds({ id: 'a' });
    expect(ids).toEqual(expect.arrayContaining(['overview', 'automation', 'documents', 'git', 'gsd', 'issues', 'processes', 'references', 'tasks']));
  });
});

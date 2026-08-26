import { describe, expect, it, vi } from 'vitest';
import {
  appendTaskDataInputs,
  listForgePullRequests,
  renderForgeItems,
  resolveTaskDataInputs,
} from './taskDataInputs.js';
import { getTaskDataInputCatalog } from '../lib/taskDataInputCatalog.js';

const APP = { id: 'app-1', name: 'Example App', repoPath: '/repo' };

describe('taskDataInputs', () => {
  it('exposes a stable reusable catalog', () => {
    expect(getTaskDataInputCatalog().map(({ id }) => id)).toEqual([
      'product-requirements',
      'project-goals',
      'open-issues',
      'open-pull-requests',
      'closed-unmerged-pull-requests',
    ]);
  });

  it('resolves selected sources in configured order and reuses one forge resolution', async () => {
    const resolveForge = vi.fn().mockResolvedValue({ cli: 'gh', env: { GH_TOKEN: 'test-token' } });
    const findFiles = vi.fn(async (_root, filename) => [{ path: filename, content: `${filename} body` }]);
    const listIssues = vi.fn().mockResolvedValue({
      ok: true,
      issues: [{ number: 4, title: 'Open work', state: 'open', labels: ['plan'] }],
    });
    const listPullRequests = vi.fn().mockResolvedValue({
      ok: true,
      items: [{ number: 8, title: 'Current change', author: { login: 'alice' } }],
    });

    const sections = await resolveTaskDataInputs([
      'project-goals', 'open-issues', 'open-pull-requests', 'project-goals'
    ], { app: APP, dependencies: { resolveForge, findFiles, listIssues, listPullRequests } });

    expect(sections.map(({ id }) => id)).toEqual(['project-goals', 'open-issues', 'open-pull-requests']);
    expect(sections[0].content).toContain('GOALS.md body');
    expect(sections[1].content).toContain('#4 Open work');
    expect(sections[2].content).toContain('#8 Current change');
    expect(resolveForge).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith(expect.objectContaining({ cli: 'gh', cwd: '/repo' }));
  });

  it('preserves failed versus legitimately empty tracker reads', async () => {
    const common = {
      app: APP,
      dependencies: {
        resolveForge: vi.fn().mockResolvedValue({ cli: 'gh', env: {} }),
        listIssues: vi.fn().mockResolvedValue({ ok: false, issues: [] }),
      },
    };
    const failed = await resolveTaskDataInputs(['open-issues'], common);
    expect(failed[0].content).toContain('could not be preloaded');
    expect(failed[0].content).toContain('Do not interpret this as an empty source');

    common.dependencies.listIssues.mockResolvedValue({ ok: true, issues: [] });
    const empty = await resolveTaskDataInputs(['open-issues'], common);
    expect(empty[0].content).toBe('No open issues.');
  });

  it('appends one bounded prompt section with a no-refetch instruction', () => {
    const prompt = appendTaskDataInputs('Do the task.', [
      { id: 'project-goals', label: 'Project goals', content: 'Ship useful work.' },
    ]);
    expect(prompt).toContain('Do the task.');
    expect(prompt).toContain('## Preloaded task data');
    expect(prompt).toContain('do not spend tools or tokens fetching the same data again');
    expect(prompt).toContain('### Project goals');
  });

  it('renders forge metadata without serializing label objects', () => {
    const rendered = renderForgeItems([{
      number: 2,
      title: 'Example',
      labels: [{ name: 'plan' }],
      author: { username: 'alice' },
      source_branch: 'feature/example',
    }], { emptyMessage: 'None.' });
    expect(rendered).toContain('labels: plan');
    expect(rendered).toContain('author: alice');
    expect(rendered).not.toContain('[object Object]');
  });

  it('lists GitHub closed-unmerged pull requests with explicit search semantics', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '[]', stderr: '' });
    await expect(listForgePullRequests({
      cli: 'gh', cwd: '/repo', state: 'closed-unmerged', exec
    })).resolves.toEqual({ ok: true, items: [] });
    expect(exec).toHaveBeenCalledWith('gh', expect.arrayContaining([
      '--state', 'closed', '--search', 'is:unmerged'
    ]), expect.objectContaining({ cwd: '/repo' }));
  });
});

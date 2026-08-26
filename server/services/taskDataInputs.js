/**
 * Scheduled-task data inputs.
 *
 * Resolves reusable, deterministic repository/tracker context before an agent
 * starts. Schedules and custom jobs persist only catalog ids; this module owns
 * the I/O and the single prompt rendering contract for every consumer.
 */

import { readdir } from 'fs/promises';
import { join, relative } from 'path';
import { safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { TASK_DATA_INPUT_DEFINITIONS } from '../lib/taskDataInputCatalog.js';
import { withGlabJson } from '../lib/glabArgs.js';
import { resolveForgeForRepo } from './git.js';
import { runCli } from './layeredIntelligence/runCli.js';

const MAX_DOCUMENT_FILES = 3;
const MAX_DOCUMENT_CHARS = 8_000;
const MAX_LIST_ITEMS = 50;
const MAX_INPUT_CHARS = 12_000;
const MAX_TOTAL_CHARS = 40_000;
const SEARCH_MAX_DEPTH = 4;
const SKIP_DIRECTORIES = new Set([
  '.git', '.idea', '.next', '.turbo', '.venv', '.vscode',
  'build', 'coverage', 'dist', 'node_modules', 'vendor', 'data'
]);

async function findNamedFiles(root, filename, {
  readDir = readdir,
  readFile = tryReadFile,
  maxDepth = SEARCH_MAX_DEPTH,
  maxFiles = MAX_DOCUMENT_FILES,
} = {}) {
  if (!root) return [];
  const matches = [];
  const target = filename.toLowerCase();

  async function walk(directory, depth) {
    if (matches.length >= maxFiles || depth > maxDepth) return;
    const entries = await readDir(directory, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    // Files first and alphabetical traversal make root documents win while the
    // bounded fallback remains deterministic across platforms.
    const ordered = [...entries].sort((a, b) => {
      if (a.isFile() !== b.isFile()) return a.isFile() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of ordered) {
      if (matches.length >= maxFiles) return;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) {
        const content = await readFile(path);
        if (typeof content === 'string') {
          matches.push({ path: relative(root, path) || entry.name, content: content.slice(0, MAX_DOCUMENT_CHARS) });
        }
      } else if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
        await walk(path, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return matches;
}

export function renderRepositoryDocuments(filename, documents) {
  if (!documents.length) return `No ${filename} file was found within the repository search boundary.`;
  return documents.map(({ path, content }) => `#### ${path}\n\n${content}`).join('\n\n').slice(0, MAX_INPUT_CHARS);
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean);
}

export function renderForgeItems(items, { emptyMessage }) {
  if (!items.length) return emptyMessage;
  const shown = items.slice(0, MAX_LIST_ITEMS);
  const lines = shown.map((item) => {
    const number = item.number ?? item.iid;
    const ref = number != null ? `#${number} ` : '';
    const author = item.author?.login || item.author?.username || item.author?.name || item.authorLogin;
    const labels = normalizeLabels(item.labels);
    const details = [
      item.isDraft === true || item.draft === true ? 'draft' : null,
      author ? `author: ${author}` : null,
      labels.length ? `labels: ${labels.join(', ')}` : null,
      item.headRefName || item.source_branch ? `head: ${item.headRefName || item.source_branch}` : null,
    ].filter(Boolean).join('; ');
    const url = item.url || item.web_url;
    return `- ${ref}${String(item.title || '').trim()}${details ? ` (${details})` : ''}${url ? ` — ${url}` : ''}`;
  });
  if (items.length > shown.length) lines.push(`- ${items.length - shown.length} additional item(s) omitted.`);
  return lines.join('\n').slice(0, MAX_INPUT_CHARS);
}

export async function listForgeOpenIssues({ cli, cwd, env, exec = runCli } = {}) {
  if (!cwd || (cli !== 'gh' && cli !== 'glab')) return { ok: false, issues: [] };
  const args = cli === 'glab'
    ? withGlabJson(['issue', 'list', '-P', '100'])
    : ['issue', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,state,url,labels'];
  const result = await exec(cli, args, { cwd, env });
  if (result.code !== 0) return { ok: false, issues: [] };
  const parsed = safeJSONParse(result.stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return result.stdout.trim() ? { ok: false, issues: [] } : { ok: true, issues: [] };
  return {
    ok: true,
    issues: parsed
      .filter((item) => !item.state || ['open', 'opened'].includes(String(item.state).toLowerCase()))
      .map((item) => ({
        number: item.number ?? item.iid,
        title: item.title || '',
        state: 'open',
        url: item.url || item.web_url || null,
        labels: normalizeLabels(item.labels),
      })),
  };
}

export async function listForgePullRequests({ cli, cwd, env, state = 'open', exec = runCli } = {}) {
  if (!cwd || (cli !== 'gh' && cli !== 'glab')) return { ok: false, items: [] };
  const closed = state === 'closed-unmerged';
  const args = cli === 'glab'
    ? withGlabJson(['mr', 'list', closed ? '--closed' : '--opened', '-P', closed ? '20' : '100'])
    : [
        'pr', 'list', '--state', closed ? 'closed' : 'open',
        ...(closed ? ['--search', 'is:unmerged'] : []),
        '--limit', closed ? '20' : '100',
        '--json', 'number,title,author,url,isDraft,headRefName,baseRefName,labels,closedAt'
      ];
  const result = await exec(cli, args, { cwd, env });
  if (result.code !== 0) return { ok: false, items: [] };
  const parsed = safeJSONParse(result.stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return result.stdout.trim() ? { ok: false, items: [] } : { ok: true, items: [] };
  // GitLab's --closed excludes merged MRs on current glab versions. Keep the
  // explicit filter as a compatibility guard if a version returns both.
  const items = closed
    ? parsed.filter((item) => !item.merged_at && String(item.state || '').toLowerCase() !== 'merged')
    : parsed;
  return { ok: true, items };
}

function unavailableMessage(label, reason = 'source read failed') {
  return `${label} could not be preloaded (${reason}). Do not interpret this as an empty source.`;
}

async function resolveForgeContext(app, resolveForge) {
  if (!app?.repoPath) return null;
  const forge = await resolveForge(app.repoPath);
  return forge?.cli === 'gh' || forge?.cli === 'glab' ? forge : null;
}

const INPUT_LOADERS = {
  'product-requirements': async ({ app, deps }) => renderRepositoryDocuments(
    'PRD.md', await deps.findFiles(app?.repoPath, 'PRD.md')
  ),
  'project-goals': async ({ app, deps }) => renderRepositoryDocuments(
    'GOALS.md', await deps.findFiles(app?.repoPath, 'GOALS.md')
  ),
  'open-issues': async ({ app, deps, forge }) => {
    if (!forge) return unavailableMessage('Open issues', 'repository forge is unavailable');
    const result = await deps.listIssues({ cli: forge.cli, cwd: app.repoPath, env: forge.env });
    return result.ok
      ? renderForgeItems(result.issues, { emptyMessage: 'No open issues.' })
      : unavailableMessage('Open issues');
  },
  'open-pull-requests': async ({ app, deps, forge }) => {
    if (!forge) return unavailableMessage('Open pull requests', 'repository forge is unavailable');
    const result = await deps.listPullRequests({ cli: forge.cli, cwd: app.repoPath, env: forge.env, state: 'open' });
    return result.ok
      ? renderForgeItems(result.items, { emptyMessage: 'No open pull requests.' })
      : unavailableMessage('Open pull requests');
  },
  'closed-unmerged-pull-requests': async ({ app, deps, forge }) => {
    if (!forge) return unavailableMessage('Closed unmerged pull requests', 'repository forge is unavailable');
    const result = await deps.listPullRequests({ cli: forge.cli, cwd: app.repoPath, env: forge.env, state: 'closed-unmerged' });
    return result.ok
      ? renderForgeItems(result.items, { emptyMessage: 'No recently closed unmerged pull requests.' })
      : unavailableMessage('Closed unmerged pull requests');
  },
};

/** Resolve selected input ids into prompt-ready sections without throwing. */
export async function resolveTaskDataInputs(inputIds, { app, dependencies = {} } = {}) {
  const selected = Array.isArray(inputIds) ? [...new Set(inputIds)] : [];
  if (!selected.length) return [];
  const definitions = new Map(TASK_DATA_INPUT_DEFINITIONS.map((definition) => [definition.id, definition]));
  const deps = {
    findFiles: findNamedFiles,
    resolveForge: resolveForgeForRepo,
    listIssues: listForgeOpenIssues,
    listPullRequests: listForgePullRequests,
    ...dependencies,
  };
  const needsForge = selected.some((id) => id.includes('issues') || id.includes('pull-requests'));
  const forge = needsForge
    ? await resolveForgeContext(app, deps.resolveForge).catch(() => null)
    : null;

  const sections = await Promise.all(selected.map(async (id) => {
    const definition = definitions.get(id);
    const loader = INPUT_LOADERS[id];
    if (!definition || !loader) return null;
    const content = await loader({ app, deps, forge }).catch(() => unavailableMessage(definition.label));
    return { id, label: definition.label, content };
  }));
  return sections.filter(Boolean);
}

export function appendTaskDataInputs(prompt, sections) {
  if (!Array.isArray(sections) || sections.length === 0) return prompt;
  const rendered = sections
    .map(({ label, content }) => `### ${label}\n\n${content}`)
    .join('\n\n')
    .slice(0, MAX_TOTAL_CHARS);
  return `${prompt}\n\n---\n\n## Preloaded task data\n\nPortOS collected these configured inputs immediately before this task was queued. Treat them as the current snapshot; do not spend tools or tokens fetching the same data again unless a section says it could not be preloaded or the task requires deeper detail.\n\n${rendered}`;
}

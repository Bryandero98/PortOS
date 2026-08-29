import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('./obsidian.js', () => ({
  getVaultById: vi.fn(),
  scanVault: vi.fn(),
  getNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock('./idealoomLists.js', () => ({
  getSettings: vi.fn(),
  getList: vi.fn(),
  listLists: vi.fn(),
  upsertImportedList: vi.fn(),
  updateSyncMetadata: vi.fn(),
}));

import * as obsidian from './obsidian.js';
import * as lists from './idealoomLists.js';
import {
  importFromObsidian,
  parseIdeaLoomMarkdown,
  renderIdeaLoomMarkdown,
  exportToObsidian,
} from './idealoomObsidian.js';

const VAULT_ID = '0f6c6a6f-8c16-4c7d-9a8b-2e2f6f2cb4d1';
const LIST_ID = 'f1c2d3e4-5678-4abc-9def-0123456789ab';
let vaultRoot;

const list = (overrides = {}) => ({
  id: LIST_ID,
  prompt: 'What should we build next?',
  title: 'Next steps: "small"',
  category: 'product',
  status: 'draft',
  help: 'Keep the ideas practical.',
  ideas: ['First idea', 'Second idea'],
  createdAt: '2026-08-29T10:00:00.000Z',
  updatedAt: '2026-08-29T11:00:00.000Z',
  ...overrides,
});

const note = (overrides = {}) => ({
  path: 'Idea Loom/2026-08-29-next-steps.md',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  if (vaultRoot) rmSync(vaultRoot, { recursive: true, force: true });
  vaultRoot = mkdtempSync(join(tmpdir(), 'idealoom-obsidian-test-'));
  mkdirSync(join(vaultRoot, 'Idea Loom'), { recursive: true });
  lists.getSettings.mockResolvedValue({ enabled: true, obsidianVaultId: VAULT_ID, autoSync: false });
  obsidian.getVaultById.mockResolvedValue({ id: VAULT_ID, name: 'Example Vault', path: vaultRoot });
  obsidian.scanVault.mockResolvedValue({ vault: { path: vaultRoot }, notes: [], skippedUnavailable: 0 });
  lists.listLists.mockResolvedValue([]);
});

describe('IdeaLoom Markdown contract', () => {
  it('round-trips escaped metadata, help text, and ordered ideas', () => {
    const original = list({ title: 'Quotes "and" \\slashes', help: 'A helpful note: preserve it.' });
    const parsed = parseIdeaLoomMarkdown(renderIdeaLoomMarkdown(original));

    expect(parsed).toEqual({
      ok: true,
      list: expect.objectContaining({
        id: original.id,
        title: original.title,
        category: original.category,
        status: original.status,
        prompt: original.prompt,
        help: original.help,
        ideas: original.ideas,
        createdAt: original.createdAt,
        updatedAt: original.updatedAt,
      }),
    });
  });

  it('round-trips a literal Prompt heading without consuming the first idea', () => {
    const original = list({ prompt: 'Prompt', help: '' });
    const parsed = parseIdeaLoomMarkdown(renderIdeaLoomMarkdown(original));

    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      list: expect.objectContaining({ prompt: 'Prompt', ideas: original.ideas }),
    }));
  });

  it('rejects malformed metadata and non-dense numbered ideas', () => {
    const rendered = renderIdeaLoomMarkdown(list());
    expect(parseIdeaLoomMarkdown(rendered.replace(`id: "${LIST_ID}"`, 'id: "not-a-uuid"')).ok).toBe(false);
    expect(parseIdeaLoomMarkdown(rendered.replace('status: "draft"', 'status: "archived"')).ok).toBe(false);
    expect(parseIdeaLoomMarkdown(rendered.replace('1. First idea\n2. Second idea', '1. First idea\n3. Second idea')).error)
      .toMatch(/dense/);
    expect(parseIdeaLoomMarkdown('---\nid: "' + LIST_ID + '"\n---\n# Prompt').ok).toBe(false);
    expect(parseIdeaLoomMarkdown(rendered.replace('  - "idea-loom"', '  - "other-note"')).error)
      .toMatch(/idea-loom/);
    expect(parseIdeaLoomMarkdown(rendered.replace(`title: "Next steps: \\\"small\\\""`, `title: "${'x'.repeat(201)}"`)).error)
      .toMatch(/limits/);
  });
});

describe('IdeaLoom Obsidian exchange', () => {
  it('does no vault I/O while disabled or unconfigured', async () => {
    lists.getSettings.mockResolvedValueOnce({ enabled: false, obsidianVaultId: null, autoSync: false });
    expect((await importFromObsidian()).counts.skipped).toBe(1);
    expect(obsidian.getVaultById).not.toHaveBeenCalled();
    expect(obsidian.scanVault).not.toHaveBeenCalled();

    lists.getSettings.mockResolvedValueOnce({ enabled: true, obsidianVaultId: null, autoSync: false });
    expect((await exportToObsidian()).counts.skipped).toBe(1);
    expect(obsidian.getVaultById).not.toHaveBeenCalled();
  });

  it('imports valid notes, surfaces malformed and unavailable notes, and is idempotent', async () => {
    const valid = renderIdeaLoomMarkdown(list());
    const validNote = note();
    const malformedNote = note({ path: 'Idea Loom/malformed.md' });
    const unavailableNote = note({ path: 'Idea Loom/cloud.md' });
    obsidian.scanVault.mockResolvedValue({
      vault: { path: vaultRoot },
      notes: [validNote, malformedNote, unavailableNote],
      skippedUnavailable: 0,
    });
    obsidian.getNote.mockImplementation(async (_vaultId, path) => {
      if (path === validNote.path) return { content: valid };
      if (path === malformedNote.path) return { content: 'not IdeaLoom' };
      return { error: 'NOTE_EVICTED' };
    });
    let stored = null;
    lists.getList.mockImplementation(async () => stored);
    lists.upsertImportedList.mockImplementation(async (id, data) => { stored = { id, ...data }; return stored; });

    const first = await importFromObsidian();
    expect(first.counts).toMatchObject({ imported: 1, malformed: 1, unavailable: 1 });
    expect(lists.upsertImportedList).toHaveBeenCalledWith(LIST_ID, expect.objectContaining({
      sync: expect.objectContaining({ notePath: validNote.path, lastKnownContentHash: expect.any(String) }),
    }));

    const second = await importFromObsidian();
    expect(second.counts).toMatchObject({ skipped: 1, malformed: 1, unavailable: 1 });
    expect(lists.upsertImportedList).toHaveBeenCalledOnce();
  });

  it('skips duplicate UUIDs without importing either note', async () => {
    const valid = renderIdeaLoomMarkdown(list());
    const first = note();
    const second = note({ path: 'Idea Loom/duplicate.md' });
    obsidian.scanVault.mockResolvedValue({ vault: { path: vaultRoot }, notes: [first, second], skippedUnavailable: 0 });
    obsidian.getNote.mockResolvedValue({ content: valid });

    const result = await importFromObsidian();
    expect(result.counts).toMatchObject({ skipped: 2, imported: 0 });
    expect(result.details.skipped.every((entry) => entry.reason === 'duplicate-id')).toBe(true);
    expect(lists.upsertImportedList).not.toHaveBeenCalled();
  });

  it('exports a new list and preserves an imported filename', async () => {
    const local = list();
    lists.listLists.mockResolvedValue([local]);
    obsidian.getNote.mockResolvedValue({ error: 'NOTE_NOT_FOUND' });
    obsidian.createNote.mockResolvedValue({ path: 'created' });

    const created = await exportToObsidian();
    expect(created.counts.exported).toBe(1);
    expect(obsidian.createNote).toHaveBeenCalledWith(VAULT_ID, expect.stringMatching(/^Idea Loom\/2026-08-29-next-steps-small\.md$/), expect.stringContaining('1. First idea'));
    expect(lists.updateSyncMetadata).toHaveBeenCalledWith(LIST_ID, expect.objectContaining({ notePath: expect.stringContaining('Idea Loom/') }));

    const importedPath = 'Idea Loom/2026-01-01-original-name.md';
    lists.listLists.mockResolvedValue([local, list({ id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d', sync: { notePath: importedPath } })]);
    obsidian.getNote.mockImplementation(async (_id, path) => path === importedPath
      ? { content: renderIdeaLoomMarkdown(list({ id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d' })) }
      : { error: 'NOTE_NOT_FOUND' });
    obsidian.updateNote.mockResolvedValue({ path: importedPath });
    obsidian.createNote.mockResolvedValue({ path: 'created' });

    const exported = await exportToObsidian({ listId: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d' });
    expect(exported.counts.exported).toBe(1);
    expect(obsidian.updateNote).toHaveBeenCalledWith('0f6c6a6f-8c16-4c7d-9a8b-2e2f6f2cb4d1', importedPath, expect.any(String));
  });
});

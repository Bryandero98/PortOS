import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './303-persistent-mind-image-attachments.js';
import { PERSISTENT_MIND_SCHEMA_VERSION } from '../../server/lib/persistentMind.js';

let rootDir;

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

const statePath = () => join(rootDir, 'data', 'cos', 'state.json');

describe('migration 303 — persistent mind image attachments', () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-mind-attachments-'));
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
  });

  it('does nothing when no CoS state exists yet', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
  });

  it('adds the pending index while preserving legacy text-only queued and active state', async () => {
    const legacy = {
      schemaVersion: 2,
      enabled: true,
      started: true,
      status: 'thinking',
      queuedMessages: [{ id: 'message-1', text: 'Keep this text.', createdAt: '2026-08-27T00:00:00.000Z' }],
      activeTurn: {
        id: 'turn-1',
        wake: { kind: 'message', message: { id: 'message-2', text: 'Keep this wake.', createdAt: '2026-08-27T00:01:00.000Z' } },
      },
    };
    await writeFile(statePath(), JSON.stringify({ config: {}, persistentMind: legacy }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    const migrated = JSON.parse(await readFile(statePath(), 'utf8')).persistentMind;
    expect(migrated).toMatchObject({
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      pendingAttachments: [],
      recentMessageFingerprints: [],
      queuedMessages: legacy.queuedMessages,
      activeTurn: legacy.activeTurn,
    });
  });

  it('is idempotent once the schema and pending index are present', async () => {
    const current = {
      schemaVersion: PERSISTENT_MIND_SCHEMA_VERSION,
      pendingAttachments: [],
      recentMessageFingerprints: [],
      enabled: false,
    };
    await writeFile(statePath(), JSON.stringify({ persistentMind: current }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    expect(JSON.parse(await readFile(statePath(), 'utf8')).persistentMind).toEqual(current);
  });

  it('leaves invalid and missing persistent mind slices untouched', async () => {
    await writeFile(statePath(), JSON.stringify({ config: {} }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-persistent-mind' });

    await writeFile(statePath(), '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state' });
  });
});

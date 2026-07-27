import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { up } from './210-usage-cache-token-fields.js';

const roots = [];

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-210-'));
  roots.push(root);
  await mkdir(join(root, 'data'), { recursive: true });
  return root;
};

const readUsage = async (rootDir) =>
  JSON.parse(await readFile(join(rootDir, 'data', 'usage.json'), 'utf8'));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('migration 210 — usage cache token fields', () => {
  it('seeds cache fields and stamps existing counts as estimates', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'data', 'usage.json'), JSON.stringify({
      dailyActivity: {
        '2026-07-20': {
          sessions: 1,
          messages: 2,
          tokens: 400,
          byProvider: {
            'claude-code': {
              name: 'Claude Code',
              sessions: 1,
              messages: 2,
              tokensIn: 30,
              tokensOut: 400,
              byModel: {
                'claude-opus-5': { sessions: 1, messages: 2, tokensIn: 30, tokensOut: 400 }
              }
            }
          }
        }
      },
      monthlyActivity: {
        '2026-06': {
          byProvider: {
            codex: { name: 'Codex', sessions: 5, messages: 5, tokensIn: 10, tokensOut: 900, byModel: {} }
          }
        }
      }
    }));

    await up({ rootDir });
    const usage = await readUsage(rootDir);

    const provider = usage.dailyActivity['2026-07-20'].byProvider['claude-code'];
    expect(provider).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, source: 'estimate' });
    expect(provider.byModel['claude-opus-5']).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, source: 'estimate' });
    expect(usage.monthlyActivity['2026-06'].byProvider.codex).toMatchObject({ source: 'estimate' });
    // Existing counts are untouched — this is a labeling pass, not a rewrite.
    expect(provider.tokensOut).toBe(400);
    expect(provider.tokensIn).toBe(30);
  });

  it('leaves a bucket with no counts unlabeled so its first record decides', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'data', 'usage.json'), JSON.stringify({
      dailyActivity: {
        '2026-07-20': {
          sessions: 1,
          byProvider: {
            'claude-code': { name: 'Claude Code', sessions: 1, messages: 0, tokensIn: 0, tokensOut: 0, byModel: {} }
          }
        }
      }
    }));

    await up({ rootDir });
    const usage = await readUsage(rootDir);
    expect(usage.dailyActivity['2026-07-20'].byProvider['claude-code'].source).toBeNull();
  });

  it('preserves an already-measured source and existing cache counts', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'data', 'usage.json'), JSON.stringify({
      dailyActivity: {
        '2026-07-20': {
          byProvider: {
            'claude-code': {
              name: 'Claude Code',
              sessions: 1, messages: 1, tokensIn: 5, tokensOut: 9,
              cacheReadTokens: 1234, cacheWriteTokens: 56, source: 'measured',
              byModel: {}
            }
          }
        }
      }
    }));

    await up({ rootDir });
    const usage = await readUsage(rootDir);
    expect(usage.dailyActivity['2026-07-20'].byProvider['claude-code']).toMatchObject({
      cacheReadTokens: 1234, cacheWriteTokens: 56, source: 'measured'
    });
  });

  it('is idempotent', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'data', 'usage.json'), JSON.stringify({
      dailyActivity: {
        '2026-07-20': {
          byProvider: { codex: { name: 'Codex', sessions: 1, messages: 1, tokensIn: 1, tokensOut: 2, byModel: {} } }
        }
      }
    }));

    await up({ rootDir });
    const first = await readUsage(rootDir);
    await up({ rootDir });
    expect(await readUsage(rootDir)).toEqual(first);
  });

  it('is a no-op when the usage file does not exist yet', async () => {
    const rootDir = await makeRoot();
    await expect(up({ rootDir })).resolves.toBeUndefined();
  });

  it('tolerates a file with no activity maps at all', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'data', 'usage.json'), JSON.stringify({ totalSessions: 0 }));
    await expect(up({ rootDir })).resolves.toBeUndefined();
    expect(await readUsage(rootDir)).toEqual({ totalSessions: 0 });
  });
});

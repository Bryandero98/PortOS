import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { up } from './208-rename-undefined-usage-provider.js';

const roots = [];

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-208-'));
  roots.push(root);
  await mkdir(join(root, 'data'), { recursive: true });
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('migration 208 — undefined usage provider', () => {
  it('renames and merges top-level, daily, and monthly provider buckets', async () => {
    const rootDir = await makeRoot();
    const usagePath = join(rootDir, 'data', 'usage.json');
    await writeFile(usagePath, JSON.stringify({
      byProvider: {
        unknown: { name: 'Unknown provider', sessions: 2, messages: 1, tokens: 10 },
        undefined: { sessions: 3, messages: 4, tokens: 20 }
      },
      dailyActivity: {
        '2026-07-20': {
          byProvider: {
            undefined: { sessions: 1, messages: 2, tokensIn: 3, tokensOut: 4, byModel: {} }
          }
        }
      },
      monthlyActivity: {
        '2026-06': {
          byProvider: {
            unknown: { name: 'Unknown provider', sessions: 1, byModel: { model: { sessions: 1 } } },
            undefined: { sessions: 2, byModel: { model: { sessions: 2 } } }
          }
        }
      }
    }));

    await up({ rootDir });

    const usage = JSON.parse(await readFile(usagePath, 'utf8'));
    expect(usage.byProvider.undefined).toBeUndefined();
    expect(usage.byProvider.unknown).toMatchObject({
      name: 'Unknown provider',
      sessions: 5,
      messages: 5,
      tokens: 30
    });
    expect(usage.dailyActivity['2026-07-20'].byProvider).toEqual({
      unknown: {
        name: 'Unknown provider',
        sessions: 1,
        messages: 2,
        tokensIn: 3,
        tokensOut: 4,
        byModel: {}
      }
    });
    expect(usage.monthlyActivity['2026-06'].byProvider.unknown.byModel.model.sessions).toBe(3);
  });

  it('is a no-op when usage.json is absent or already normalized', async () => {
    const missingRoot = await makeRoot();
    await expect(up({ rootDir: missingRoot })).resolves.toBeUndefined();

    const normalizedRoot = await makeRoot();
    const usagePath = join(normalizedRoot, 'data', 'usage.json');
    const raw = JSON.stringify({ byProvider: { codex: { sessions: 1 } } });
    await writeFile(usagePath, raw);
    await up({ rootDir: normalizedRoot });
    expect(await readFile(usagePath, 'utf8')).toBe(raw);
  });
});

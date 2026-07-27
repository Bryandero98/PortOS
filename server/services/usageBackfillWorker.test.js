import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { __resetUsageClaims } from './usageReconciler.js';
import { scanHistoricalUsage } from './usageBackfillWorker.js';

let root;
let home;
const workspace = '/work/example-repo';

const writeRun = async (id, metadata, output = 'estimated output') => {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, ...metadata }));
  await writeFile(join(dir, 'output.txt'), output);
};

const writeTranscript = async () => {
  const dir = join(home, '.claude', 'projects', '-work-example-repo');
  await mkdir(dir, { recursive: true });
  const line = {
    type: 'assistant',
    uuid: 'uuid-message-1',
    sessionId: 'session-example',
    cwd: workspace,
    timestamp: '2026-07-01T10:05:00.000Z',
    message: {
      id: 'message-1',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 1000,
        output_tokens: 200
      }
    }
  };
  await writeFile(join(dir, 'session-example.jsonl'), JSON.stringify(line));
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'portos-runs-example-'));
  home = await mkdtemp(join(tmpdir(), 'portos-home-example-'));
  __resetUsageClaims();
  await writeTranscript();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('historical usage worker', () => {
  it('correlates by run metadata and keeps the configured provider id', async () => {
    await writeRun('run-example-1', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      promptLength: 80,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z'
    });
    await writeRun('run-outside-window', {
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      workspacePath: workspace,
      startTime: '2026-07-02T10:00:00.000Z',
      endTime: '2026-07-02T10:10:00.000Z'
    });

    const result = await scanHistoricalUsage({ runsDir: root, home });
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({
      runId: 'run-example-1',
      providerId: 'claude-code-tui',
      day: '2026-07-01'
    });
    expect(result.corrections[0].measured[0]).toMatchObject({
      providerId: 'claude-code-tui',
      tokensOut: 200,
      cacheReadTokens: 1000
    });
  });

  it('skips a run already recorded by the live completion path', async () => {
    await writeRun('run-live-recorded', {
      providerId: 'claude-code-tui',
      workspacePath: workspace,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      usageReconciled: true
    });

    const result = await scanHistoricalUsage({ runsDir: root, home });
    expect(result.total).toBe(0);
    expect(result.corrections).toEqual([]);
  });
});

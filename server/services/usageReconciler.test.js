import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./usage.js', () => ({
  recordRunUsage: vi.fn().mockResolvedValue(undefined)
}));

const { recordRunUsage } = await import('./usage.js');
const {
  transcriptFamily,
  readMeasuredUsage,
  reconcileRunUsage,
  recordCompletedRunUsage,
  __resetUsageClaims
} = await import('./usageReconciler.js');

// Fake HOME per test so the parsers read fixtures, never the developer's real
// ~/.claude or ~/.codex (which hold private session data — see CLAUDE.md).
let home;
const WORKSPACE = '/work/example-repo';
// claudeProjectSlug(WORKSPACE) — the CLI names its project dir after the cwd.
const PROJECT_SLUG = '-work-example-repo';

const claudeAssistant = ({ id, timestamp, input = 10, cacheWrite = 100, cacheRead = 1000, output = 50, model = 'claude-opus-5' }) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `uuid-${id}`,
    sessionId: 'sess-1',
    cwd: WORKSPACE,
    timestamp,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
        output_tokens: output
      }
    }
  });

const writeClaudeSession = async (file, lines, slug = PROJECT_SLUG) => {
  const dir = join(home, '.claude', 'projects', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), lines.join('\n'));
};

const codexRollout = ({ cwd = WORKSPACE, timestamp, input, cached, output }) => [
  JSON.stringify({
    timestamp,
    type: 'session_meta',
    payload: { id: 'rollout-1', cwd, cli_version: '0.0.0', model: 'gpt-5.3-codex' }
  }),
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          total_tokens: input + output
        }
      }
    }
  })
].join('\n');

const writeCodexRollout = async (dateParts, file, text) => {
  const dir = join(home, '.codex', 'sessions', ...dateParts);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), text);
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'portos-usage-'));
  vi.clearAllMocks();
  // The claim ledger is module-level, so a stale claim from a prior test would
  // make a later read skip messages it should count.
  __resetUsageClaims();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('transcriptFamily', () => {
  it('maps every claude-flavored provider id to the claude family', () => {
    for (const providerId of ['claude-code', 'claude-code-tui', 'claude-code-tui-bedrock']) {
      expect(transcriptFamily({ providerId })).toBe('claude');
    }
  });

  it('maps codex provider ids to the codex family', () => {
    expect(transcriptFamily({ providerId: 'codex' })).toBe('codex');
    expect(transcriptFamily({ providerId: 'codex-tui' })).toBe('codex');
  });

  it('resolves from the launch command when the id is uninformative', () => {
    expect(transcriptFamily({ providerId: 'custom', command: '/usr/local/bin/claude' })).toBe('claude');
  });

  it('returns null for providers that write no transcript', () => {
    for (const providerId of ['ollama', 'lmstudio', 'agy', 'grok', 'kimi', '', null]) {
      expect(transcriptFamily({ providerId })).toBeNull();
    }
  });
});

describe('readMeasuredUsage', () => {
  it('sums every session in the run window from the cwd-slug project directory', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z' })
    ]);
    await writeClaudeSession('b.jsonl', [
      claudeAssistant({ id: 'm2', timestamp: '2026-07-01T10:06:00.000Z', output: 25, cacheRead: 500 })
    ]);

    const result = await readMeasuredUsage({
      workspacePath: WORKSPACE,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      family: 'claude',
      home
    });

    expect(result).toMatchObject({
      source: 'measured',
      sessions: 2,
      tokensOut: 75,
      cacheReadTokens: 1500,
      cacheWriteTokens: 200,
      model: 'claude-opus-5'
    });
  });

  it('excludes sessions outside the run window', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'yesterday', timestamp: '2026-06-30T10:00:00.000Z' }),
      claudeAssistant({ id: 'inRun', timestamp: '2026-07-01T10:05:00.000Z' })
    ]);

    const result = await readMeasuredUsage({
      workspacePath: WORKSPACE,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      family: 'claude',
      home
    });

    expect(result.messages).toBe(1);
    expect(result.tokensOut).toBe(50);
  });

  it('returns null when another repo owns the only sessions', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z' })
    ], '-work-some-other-repo');

    const result = await readMeasuredUsage({
      workspacePath: WORKSPACE,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      family: 'claude',
      home
    });
    expect(result).toBeNull();
  });

  it('returns null when the home directory has no transcripts at all', async () => {
    const result = await readMeasuredUsage({
      workspacePath: WORKSPACE,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      family: 'claude',
      home
    });
    expect(result).toBeNull();
  });

  it('matches a codex rollout by its session_meta cwd', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', codexRollout({
      timestamp: '2026-07-01T10:05:00.000Z', input: 3000, cached: 2400, output: 250
    }));

    const result = await readMeasuredUsage({
      workspacePath: WORKSPACE,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      family: 'codex',
      home
    });

    expect(result).toMatchObject({ sessions: 1, tokensIn: 600, cacheReadTokens: 2400, tokensOut: 250 });
  });

  it('skips a codex rollout from a different cwd', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', codexRollout({
      cwd: '/work/other', timestamp: '2026-07-01T10:05:00.000Z', input: 3000, cached: 2400, output: 250
    }));

    const result = await readMeasuredUsage({
      workspacePath: WORKSPACE,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      family: 'codex',
      home
    });
    expect(result).toBeNull();
  });

  it('accepts a CLI invoked in a subdirectory of the workspace', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', codexRollout({
      cwd: `${WORKSPACE}/server`, timestamp: '2026-07-01T10:05:00.000Z', input: 1000, cached: 0, output: 40
    }));

    const result = await readMeasuredUsage({
      workspacePath: WORKSPACE,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z',
      family: 'codex',
      home
    });
    expect(result?.tokensOut).toBe(40);
  });
});

describe('reconcileRunUsage', () => {
  const run = {
    providerId: 'claude-code-tui',
    model: 'claude-opus-5',
    workspacePath: WORKSPACE,
    startTime: '2026-07-01T10:00:00.000Z',
    endTime: '2026-07-01T10:10:00.000Z'
  };

  it('returns measured counts that match the transcript sums EXACTLY', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', input: 10, cacheWrite: 100, cacheRead: 1000, output: 50 }),
      claudeAssistant({ id: 'm2', timestamp: '2026-07-01T10:06:00.000Z', input: 5, cacheWrite: 20, cacheRead: 500, output: 25 })
    ]);

    // The estimate is deliberately nothing like the truth — a measured result
    // must not blend it in.
    const result = await reconcileRunUsage(run, { tokensIn: 30, tokensOut: 9999 }, { home });

    // One model in the transcript → one record, carrying PortOS's model id.
    expect(result).toEqual([{
      providerId: 'claude-code-tui',
      model: 'claude-opus-5',
      messages: 2,
      tokensIn: 15,
      tokensOut: 75,
      cacheReadTokens: 1500,
      cacheWriteTokens: 120,
      source: 'measured'
    }]);
  });

  // A session that switched models must be split, or the whole run prices at
  // whichever model happened to run most — e.g. Haiku tokens billed at Opus.
  it('splits a model switch into one record per model', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', model: 'claude-opus-5', output: 50, cacheRead: 1000, cacheWrite: 100, input: 10 }),
      claudeAssistant({ id: 'm2', timestamp: '2026-07-01T10:06:00.000Z', model: 'claude-haiku-4-5', output: 25, cacheRead: 500, cacheWrite: 20, input: 5 })
    ]);

    const result = await reconcileRunUsage(run, { tokensIn: 1, tokensOut: 1 }, { home });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    const byModel = Object.fromEntries(result.map((r) => [r.model, r]));
    expect(byModel['claude-opus-5']).toMatchObject({ tokensOut: 50, cacheReadTokens: 1000, cacheWriteTokens: 100, source: 'measured' });
    expect(byModel['claude-haiku-4-5']).toMatchObject({ tokensOut: 25, cacheReadTokens: 500, cacheWriteTokens: 20, source: 'measured' });
    // With >1 model the transcript's own ids win — PortOS recorded only the
    // launch-time model, which would misattribute the other one's tokens.
    expect(byModel['claude-haiku-4-5'].model).toBe('claude-haiku-4-5');
    // Split records must still sum to the session totals — no tokens lost.
    expect(result.reduce((s, r) => s + r.tokensOut, 0)).toBe(75);
    expect(result.reduce((s, r) => s + r.cacheReadTokens, 0)).toBe(1500);
  });

  it('falls back to the estimate when no transcript matches', async () => {
    const result = await reconcileRunUsage(run, { tokensIn: 30, tokensOut: 400 }, { home });
    expect(result).toMatchObject({
      tokensIn: 30,
      tokensOut: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      source: 'estimate'
    });
  });

  it('falls back to the estimate for a provider that writes no transcript', async () => {
    const result = await reconcileRunUsage(
      { ...run, providerId: 'ollama', model: 'llama3' },
      { tokensIn: 12, tokensOut: 340 },
      { home }
    );
    expect(result).toMatchObject({ providerId: 'ollama', tokensOut: 340, source: 'estimate' });
  });

  it('clamps a negative estimate to zero', async () => {
    const result = await reconcileRunUsage(run, { tokensIn: -5, tokensOut: -1 }, { home });
    expect(result).toMatchObject({ tokensIn: 0, tokensOut: 0 });
  });

  it('keeps PortOS\'s recorded model id over the transcript\'s', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', model: 'claude-opus-5' })
    ]);
    // A Bedrock-prefixed id is what the pricing table needs to resolve.
    const bedrock = { ...run, model: 'global.anthropic.claude-opus-5[1m]' };
    const result = await reconcileRunUsage(bedrock, { tokensIn: 1, tokensOut: 1 }, { home });
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe('global.anthropic.claude-opus-5[1m]');
    expect(result[0].source).toBe('measured');
  });
});

describe('recordCompletedRunUsage', () => {
  it('persists measured counts for a run with a transcript', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z' })
    ]);

    await recordCompletedRunUsage({
      providerId: 'claude-code',
      model: 'claude-opus-5',
      workspacePath: WORKSPACE,
      promptLength: 80,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z'
    }, 'some captured output', { home });

    expect(recordRunUsage).toHaveBeenCalledTimes(1);
    // One model → an array of one (recordRunUsage accepts either shape).
    expect(recordRunUsage.mock.calls[0][0]).toEqual([
      expect.objectContaining({ source: 'measured', tokensOut: 50, cacheReadTokens: 1000 })
    ]);
  });

  it('records the estimate when no transcript exists rather than recording nothing', async () => {
    await recordCompletedRunUsage({
      providerId: 'ollama',
      model: 'llama3',
      workspacePath: WORKSPACE,
      promptLength: 400,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z'
    }, 'x'.repeat(4000));

    expect(recordRunUsage).toHaveBeenCalledTimes(1);
    const record = recordRunUsage.mock.calls[0][0];
    expect(record.source).toBe('estimate');
    expect(record.tokensOut).toBeGreaterThan(0);
    expect(record.tokensIn).toBeGreaterThan(0);
  });

  it('skips a run with no providerId instead of creating an unknown bucket', async () => {
    await recordCompletedRunUsage({ workspacePath: WORKSPACE, promptLength: 10 }, 'out');
    expect(recordRunUsage).not.toHaveBeenCalled();
  });

  it('swallows a persistence failure so usage accounting never fails the run', async () => {
    recordRunUsage.mockRejectedValueOnce(new Error('disk full'));
    await expect(recordCompletedRunUsage({
      providerId: 'claude-code',
      model: 'claude-opus-5',
      workspacePath: WORKSPACE,
      promptLength: 10,
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:10:00.000Z'
    }, 'out')).resolves.toBeUndefined();
  });
});



describe('overlapping runs must not double-bill one transcript', () => {
  // PortOS runs are NOT serialized per cwd (the runner allows several
  // concurrent), and WINDOW_SLACK_MS widens each window by a minute — measured
  // against real run history, 39 same-cwd run pairs genuinely overlap and 144 do
  // once slack is applied. Without a claim, each overlapping run folds the whole
  // overlap and the reported cost doubles.
  const runA = {
    providerId: 'claude-code-tui',
    model: 'claude-opus-5',
    workspacePath: WORKSPACE,
    startTime: '2026-07-01T10:00:00.000Z',
    endTime: '2026-07-01T10:10:00.000Z'
  };
  const runB = { ...runA, startTime: '2026-07-01T10:02:00.000Z', endTime: '2026-07-01T10:12:00.000Z' };

  it('bills each message exactly once across two overlapping runs', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', output: 50, cacheRead: 1000, cacheWrite: 100, input: 10 }),
      claudeAssistant({ id: 'm2', timestamp: '2026-07-01T10:06:00.000Z', output: 25, cacheRead: 500, cacheWrite: 20, input: 5 })
    ]);

    const first = await readMeasuredUsage({ ...runA, family: 'claude', home });
    const second = await readMeasuredUsage({ ...runB, family: 'claude', home });

    // The first run takes both messages; the second finds them already claimed
    // and reports nothing rather than re-billing them.
    expect(first.tokensOut).toBe(75);
    expect(first.cacheReadTokens).toBe(1500);
    expect(second).toBeNull();

    // The union across both runs equals the transcript, not double it.
    const billedOut = (first?.tokensOut || 0) + (second?.tokensOut || 0);
    expect(billedOut).toBe(75);
  });

  it('lets a second run claim only the messages the first did not', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'early', timestamp: '2026-07-01T10:05:00.000Z', output: 50, cacheRead: 0, cacheWrite: 0, input: 0 }),
      claudeAssistant({ id: 'late', timestamp: '2026-07-01T10:11:00.000Z', output: 25, cacheRead: 0, cacheWrite: 0, input: 0 })
    ]);

    // runA's window ends at 10:10 (+60s slack → 10:11), so it takes both.
    // Narrow runA so only `early` is in range, leaving `late` for runB.
    const narrowA = { ...runA, endTime: '2026-07-01T10:06:00.000Z' };
    const first = await readMeasuredUsage({ ...narrowA, family: 'claude', home });
    const second = await readMeasuredUsage({ ...runB, family: 'claude', home });

    expect(first.tokensOut).toBe(50);
    expect(second.tokensOut).toBe(25);
    // Together they account for the session exactly once.
    expect(first.tokensOut + second.tokensOut).toBe(75);
  });

  it('does not double-bill a codex rollout read by two overlapping runs', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', codexRollout({
      timestamp: '2026-07-01T10:05:00.000Z', input: 3000, cached: 2400, output: 250
    }));

    const first = await readMeasuredUsage({ ...runA, family: 'codex', home });
    const second = await readMeasuredUsage({ ...runB, family: 'codex', home });

    expect(first.tokensOut).toBe(250);
    expect(second).toBeNull();
  });
});

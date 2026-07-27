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

describe('claim ledger — concurrency and cumulative rollouts', () => {
  const runA = {
    providerId: 'claude-code-tui',
    model: 'claude-opus-5',
    workspacePath: WORKSPACE,
    startTime: '2026-07-01T10:00:00.000Z',
    endTime: '2026-07-01T10:10:00.000Z'
  };
  const runB = { ...runA, startTime: '2026-07-01T10:02:00.000Z', endTime: '2026-07-01T10:12:00.000Z' };

  // The reads interleave at every `await` (one per transcript file), so a ledger
  // that only claims AFTER the whole read finishes lets both runs bill the same
  // messages. Reserving per file closes that window.
  it('bills each message once when two overlapping reads run CONCURRENTLY', async () => {
    // Several files, so each read awaits more than once and truly interleaves.
    await writeClaudeSession('a.jsonl', [claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', output: 50, cacheRead: 0, cacheWrite: 0, input: 0 })]);
    await writeClaudeSession('b.jsonl', [claudeAssistant({ id: 'm2', timestamp: '2026-07-01T10:06:00.000Z', output: 25, cacheRead: 0, cacheWrite: 0, input: 0 })]);
    await writeClaudeSession('c.jsonl', [claudeAssistant({ id: 'm3', timestamp: '2026-07-01T10:07:00.000Z', output: 10, cacheRead: 0, cacheWrite: 0, input: 0 })]);

    const [first, second] = await Promise.all([
      readMeasuredUsage({ ...runA, family: 'claude', home }),
      readMeasuredUsage({ ...runB, family: 'claude', home })
    ]);

    const billed = (first?.tokensOut || 0) + (second?.tokensOut || 0);
    expect(billed).toBe(85); // the transcript total, NOT 170
  });

  // A Codex rollout bills as a cumulative delta. If it GROWS between two runs,
  // a per-snapshot claim doesn't help: the later snapshot has a different key and
  // its delta re-includes the first run's tokens.
  it('bills only the new part of a rollout that grew between two runs', async () => {
    const rollout = (entries) => [
      JSON.stringify({ timestamp: '2026-07-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'rollout-1', cwd: WORKSPACE, model: 'gpt-5.3-codex' } }),
      ...entries
    ].join('\n');
    const snap = (timestamp, input, cached, output) => JSON.stringify({
      timestamp, type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } }
    });

    // First run sees cumulative output 100.
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      snap('2026-07-01T10:05:00.000Z', 1000, 0, 100)
    ]));
    const first = await readMeasuredUsage({ ...runA, family: 'codex', home });
    expect(first.tokensOut).toBe(100);

    // The rollout grows to cumulative 250 before the second (overlapping) run.
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      snap('2026-07-01T10:05:00.000Z', 1000, 0, 100),
      snap('2026-07-01T10:11:00.000Z', 3000, 0, 250)
    ]));
    const second = await readMeasuredUsage({ ...runB, family: 'codex', home });

    // Only the 150 that is genuinely new — not the full 250.
    expect(second.tokensOut).toBe(150);
    expect(first.tokensOut + second.tokensOut).toBe(250);
  });

  it('releases its reservations when nothing was attributable', async () => {
    // Another repo's session: reserved during the read, then released because
    // this run folded nothing — so a run that DOES own it can still bill it.
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z' })
    ], '-work-some-other-repo');

    // This run's own project dir is empty, so it folds nothing and returns null.
    const miss = await readMeasuredUsage({ ...runA, family: 'claude', home });
    expect(miss).toBeNull();

    // The repo that actually owns that session still bills it — proving the
    // failed read released whatever it had reserved instead of stranding it.
    const real = await readMeasuredUsage({
      workspacePath: '/work/some-other-repo',
      startTime: runA.startTime, endTime: runA.endTime, family: 'claude', home
    });
    expect(real?.tokensOut).toBe(50);

    // …and a SECOND read by the true owner is now correctly blocked (claimed).
    expect(await readMeasuredUsage({
      workspacePath: '/work/some-other-repo',
      startTime: runA.startTime, endTime: runA.endTime, family: 'claude', home
    })).toBeNull();
  });
});

describe('model attribution when the transcript disagrees', () => {
  const run = {
    providerId: 'claude-code-tui-bedrock',
    model: 'global.anthropic.claude-opus-5[1m]',
    workspacePath: WORKSPACE,
    startTime: '2026-07-01T10:00:00.000Z',
    endTime: '2026-07-01T10:10:00.000Z'
  };

  it('keeps the recorded Bedrock id when it resolves to the same model', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', model: 'claude-opus-5' })
    ]);
    const [record] = await reconcileRunUsage(run, { tokensIn: 1, tokensOut: 1 }, { home });
    // The Bedrock prefix/suffix carries provider shape the transcript strips.
    expect(record.model).toBe('global.anthropic.claude-opus-5[1m]');
  });

  // A run launched as Opus that actually fell back to a local model must NOT be
  // billed at Opus rates.
  it('prefers the transcript when the run fell back to a local model', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', model: 'qwen3.6:35b' })
    ]);
    const [record] = await reconcileRunUsage(run, { tokensIn: 1, tokensOut: 1 }, { home });
    expect(record.model).toBe('qwen3.6:35b');
  });

  it('prefers the transcript when it names a different hosted model', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', model: 'claude-haiku-4-5' })
    ]);
    const [record] = await reconcileRunUsage(run, { tokensIn: 1, tokensOut: 1 }, { home });
    expect(record.model).toBe('claude-haiku-4-5');
  });

  it('falls back to the recorded model for a model-less transcript bucket', async () => {
    const noModel = JSON.parse(claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z' }));
    delete noModel.message.model;
    await writeClaudeSession('a.jsonl', [JSON.stringify(noModel)]);
    const [record] = await reconcileRunUsage(run, { tokensIn: 1, tokensOut: 1 }, { home });
    expect(record.model).toBe('global.anthropic.claude-opus-5[1m]');
    expect(record.tokensOut).toBe(50);
  });
});

describe('Codex high-water mark tracks totals, not timestamps', () => {
  const runA = {
    providerId: 'codex-tui', model: 'gpt-5.3-codex', workspacePath: WORKSPACE,
    startTime: '2026-07-01T10:00:00.000Z', endTime: '2026-07-01T10:10:00.000Z'
  };
  const runB = { ...runA, startTime: '2026-07-01T10:02:00.000Z', endTime: '2026-07-01T10:12:00.000Z' };

  const rollout = (snaps) => [
    JSON.stringify({ timestamp: '2026-07-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'rollout-1', cwd: WORKSPACE, model: 'gpt-5.3-codex' } }),
    ...snaps.map(([timestamp, input, cached, output]) => JSON.stringify({
      timestamp, type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } }
    }))
  ].join('\n');

  // Regression: a timestamp-based boundary either re-billed snapshots sharing a
  // millisecond or, when excluding the whole millisecond, dropped the later
  // one's tokens outright. Totals are exact regardless of stamping.
  it('does not lose a delta when two snapshots share an epoch millisecond', async () => {
    const SAME_MS = '2026-07-01T10:05:00.000Z';
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([[SAME_MS, 1000, 0, 100]]));
    const first = await readMeasuredUsage({ ...runA, family: 'codex', home });
    expect(first.tokensOut).toBe(100);

    // The rollout grows, and the new snapshot carries the SAME timestamp.
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      [SAME_MS, 1000, 0, 100],
      [SAME_MS, 3000, 0, 250]
    ]));
    const second = await readMeasuredUsage({ ...runB, family: 'codex', home });

    // The additional 150 must still be billed — not dropped, not doubled.
    expect(second?.tokensOut).toBe(150);
    expect(first.tokensOut + second.tokensOut).toBe(250);
  });

  it('reports nothing when an unchanged rollout is re-read', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      ['2026-07-01T10:05:00.000Z', 1000, 0, 100]
    ]));
    const first = await readMeasuredUsage({ ...runA, family: 'codex', home });
    expect(first.tokensOut).toBe(100);
    expect(await readMeasuredUsage({ ...runB, family: 'codex', home })).toBeNull();
  });

  it('nets the per-model bucket too, so records never re-charge the billed part', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      ['2026-07-01T10:05:00.000Z', 1000, 0, 100]
    ]));
    await readMeasuredUsage({ ...runA, family: 'codex', home });

    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      ['2026-07-01T10:05:00.000Z', 1000, 0, 100],
      ['2026-07-01T10:11:00.000Z', 3000, 0, 250]
    ]));
    const second = await readMeasuredUsage({ ...runB, family: 'codex', home });
    // The model bucket must equal the NET, matching the aggregate.
    expect(second.byModel['gpt-5.3-codex'].tokensOut).toBe(second.tokensOut);
    expect(second.byModel['gpt-5.3-codex'].tokensOut).toBe(150);
  });
});

describe('attributedModel with unrecognized ids', () => {
  const run = {
    providerId: 'claude-code-tui', workspacePath: WORKSPACE,
    startTime: '2026-07-01T10:00:00.000Z', endTime: '2026-07-01T10:10:00.000Z'
  };

  // Two unknown ids both resolve to rateModel null. Treating null === null as
  // "same family" kept the launch id for a real substitution.
  it('defers to the transcript when neither id resolves to a known family', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'm1', timestamp: '2026-07-01T10:05:00.000Z', model: 'totally-other-beta' })
    ]);
    const [record] = await reconcileRunUsage(
      { ...run, model: 'some-preview-alpha' }, { tokensIn: 1, tokensOut: 1 }, { home }
    );
    expect(record.model).toBe('totally-other-beta');
  });
});

describe('model-less bucket attribution (deliberate single-bucket choice)', () => {
  const run = {
    providerId: 'claude-code-tui-bedrock',
    model: 'global.anthropic.claude-opus-5[1m]',
    workspacePath: WORKSPACE,
    startTime: '2026-07-01T10:00:00.000Z',
    endTime: '2026-07-01T10:10:00.000Z'
  };
  const unnamed = (id, timestamp, output) => {
    const line = JSON.parse(claudeAssistant({ id, timestamp, output, cacheRead: 0, cacheWrite: 0, input: 1 }));
    delete line.message.model;
    return JSON.stringify(line);
  };

  // With SEVERAL buckets the unnamed one can't be pinned to the recorded model
  // (a named bucket already holds it), so it prices at the provider default.
  it('leaves the unnamed bucket unattributed when another bucket is named', async () => {
    await writeClaudeSession('a.jsonl', [
      claudeAssistant({ id: 'named', timestamp: '2026-07-01T10:05:00.000Z', model: 'claude-opus-5', output: 100, cacheRead: 0, cacheWrite: 0, input: 1 }),
      unnamed('anon', '2026-07-01T10:06:00.000Z', 500)
    ]);

    const records = await reconcileRunUsage(run, { tokensIn: 1, tokensOut: 1 }, { home });
    const models = records.map((r) => r.model);
    expect(models).toContain('claude-opus-5');
    expect(models).toContain(null);
    // Critically: nothing is dropped — the unnamed message's tokens are recorded.
    expect(records.reduce((s, r) => s + r.tokensOut, 0)).toBe(600);
  });

  // With ONE bucket, PortOS's launch-time model is better evidence than the
  // provider default (which for a Bedrock Opus run is Sonnet — $3/$15 vs $5/$25,
  // understating the cost this feature exists to measure).
  it('uses the recorded model when the unnamed bucket is the only one', async () => {
    await writeClaudeSession('a.jsonl', [unnamed('anon', '2026-07-01T10:05:00.000Z', 500)]);
    const records = await reconcileRunUsage(run, { tokensIn: 1, tokensOut: 1 }, { home });
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe('global.anthropic.claude-opus-5[1m]');
    expect(records[0].tokensOut).toBe(500);
  });
});

describe('Codex watermark is in absolute rollout units', () => {
  const rollout = (snaps) => [
    JSON.stringify({ timestamp: '2026-07-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'rollout-1', cwd: WORKSPACE, model: 'gpt-5.3-codex' } }),
    ...snaps.map(([timestamp, input, cached, output]) => JSON.stringify({
      timestamp, type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } }
    }))
  ].join('\n');
  const read = (startTime, endTime) => readMeasuredUsage({
    workspacePath: WORKSPACE, startTime, endTime, family: 'codex', home
  });

  // Regression: storing "tokens we billed" and subtracting it from a WINDOWED
  // parse double-subtracts, because the window already excludes the earlier
  // snapshot as its baseline. Measured: the later run billed 50, not 150.
  it('bills the full new delta when the later run starts after the billed snapshot', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      ['2026-07-01T10:05:00.000Z', 1000, 0, 100]
    ]));
    const first = await read('2026-07-01T10:00:00.000Z', '2026-07-01T10:06:00.000Z');
    expect(first.tokensOut).toBe(100);

    // Grows to cumulative 250; the second run's window starts AFTER 10:05, so a
    // windowed parse alone would already report 150.
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      ['2026-07-01T10:05:00.000Z', 1000, 0, 100],
      ['2026-07-01T10:20:00.000Z', 3000, 0, 250]
    ]));
    const second = await read('2026-07-01T10:15:00.000Z', '2026-07-01T10:25:00.000Z');

    expect(second?.tokensOut).toBe(150);
    expect(first.tokensOut + second.tokensOut).toBe(250);
    // The per-model bucket must equal the netted aggregate, or records re-charge.
    expect(second.byModel['gpt-5.3-codex'].tokensOut).toBe(second.tokensOut);
  });

  it('does not re-bill a rollout that was truncated or rewritten smaller', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      ['2026-07-01T10:05:00.000Z', 1000, 0, 100]
    ]));
    expect((await read('2026-07-01T10:00:00.000Z', '2026-07-01T10:10:00.000Z')).tokensOut).toBe(100);

    // Rewritten with LOWER cumulative totals — the mark must not move backwards.
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      ['2026-07-01T10:05:00.000Z', 500, 0, 40]
    ]));
    expect(await read('2026-07-01T10:00:00.000Z', '2026-07-01T10:30:00.000Z')).toBeNull();
  });

  it('ignores a rollout whose activity falls entirely outside the run window', async () => {
    await writeCodexRollout(['2026', '07', '01'], 'rollout-1.jsonl', rollout([
      ['2026-07-01T02:00:00.000Z', 1000, 0, 100]
    ]));
    // The absolute read sees tokens, but none of them are in this run's window.
    expect(await read('2026-07-01T10:00:00.000Z', '2026-07-01T10:10:00.000Z')).toBeNull();
  });
});

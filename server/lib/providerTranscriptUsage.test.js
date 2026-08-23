import { describe, it, expect } from 'vitest';
import {
  claudeProjectSlug,
  parseClaudeTranscript,
  parseCodexRollout,
  totalTranscriptTokens,
  UNKNOWN_MODEL
} from './providerTranscriptUsage.js';

// Fixtures are hand-authored to match the real formats (verified against a live
// install) with invented paths/ids — never a transcribed real record, per the
// Sensitive Data rules in AGENTS.md.

const claudeLine = (overrides = {}) => JSON.stringify({
  type: 'assistant',
  uuid: overrides.uuid ?? 'uuid-1',
  sessionId: 'sess-abc',
  cwd: '/work/example-repo',
  timestamp: overrides.timestamp ?? '2026-07-01T10:00:00.000Z',
  requestId: overrides.requestId ?? 'req_1',
  message: {
    id: overrides.id ?? 'msg_1',
    model: overrides.model ?? 'claude-opus-5',
    role: 'assistant',
    usage: {
      input_tokens: overrides.input ?? 10,
      cache_creation_input_tokens: overrides.cacheWrite ?? 100,
      cache_read_input_tokens: overrides.cacheRead ?? 1000,
      output_tokens: overrides.output ?? 50,
      ...(overrides.usageExtras || {})
    }
  }
});

describe('claudeProjectSlug', () => {
  it('replaces slashes and dots the way the CLI names its project directory', () => {
    expect(claudeProjectSlug('/work/github.com/acme/Example'))
      .toBe('-work-github-com-acme-Example');
  });

  it('tolerates nullish input', () => {
    expect(claudeProjectSlug(null)).toBe('');
  });
});

describe('parseClaudeTranscript', () => {
  it('sums a complete session across every token tier', () => {
    const text = [
      claudeLine({ id: 'msg_1', uuid: 'u1' }),
      claudeLine({ id: 'msg_2', uuid: 'u2', input: 5, cacheWrite: 20, cacheRead: 500, output: 25 })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result).toMatchObject({
      sessionId: 'sess-abc',
      cwd: '/work/example-repo',
      model: 'claude-opus-5',
      messages: 2,
      tokensIn: 15,
      cacheWriteTokens: 120,
      cacheReadTokens: 1500,
      tokensOut: 75
    });
  });

  // The load-bearing behavior: the CLI writes one API response as SEVERAL lines
  // sharing a message.id and an identical usage block. Summing per line inflated
  // a measured session's counts ~2.3x.
  it('counts a response ONCE even when repeated across lines with the same message.id', () => {
    const text = [
      claudeLine({ id: 'msg_dup', uuid: 'u1' }),
      claudeLine({ id: 'msg_dup', uuid: 'u2' }),
      claudeLine({ id: 'msg_dup', uuid: 'u3' })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result.messages).toBe(1);
    expect(result.tokensOut).toBe(50);
    expect(result.cacheReadTokens).toBe(1000);
  });

  it('still counts a line with no message.id, keyed by its own uuid', () => {
    const noId = JSON.parse(claudeLine({ uuid: 'u9' }));
    delete noId.message.id;
    const text = [JSON.stringify(noId), JSON.stringify(noId)].join('\n');
    // Both lines carry the same uuid, so it is still one response.
    expect(parseClaudeTranscript(text).messages).toBe(1);
  });

  it('tolerates a truncated final line (session still being written)', () => {
    const text = `${claudeLine({ id: 'msg_1' })}\n{"type":"assistant","message":{"id":"msg_2","usa`;
    const result = parseClaudeTranscript(text);
    expect(result.messages).toBe(1);
    expect(result.tokensOut).toBe(50);
  });

  it('returns zeroes for a session with no assistant messages', () => {
    const text = [
      JSON.stringify({ type: 'user', sessionId: 'sess-abc', cwd: '/work/example-repo', message: { role: 'user' } }),
      JSON.stringify({ type: 'system', sessionId: 'sess-abc' })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result).toMatchObject({ messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // Session metadata is still recovered from non-assistant lines.
    expect(result.sessionId).toBe('sess-abc');
    expect(result.cwd).toBe('/work/example-repo');
    expect(totalTranscriptTokens(result)).toBe(0);
  });

  it('ignores unknown and extra fields', () => {
    const text = claudeLine({
      usageExtras: { server_tool_use: { web_search_requests: 2 }, service_tier: 'standard', brand_new_field: 7 }
    });
    const result = parseClaudeTranscript(text);
    expect(result.tokensOut).toBe(50);
    expect(result.messages).toBe(1);
  });

  it('windows by timestamp so one CLI session can split across two runs', () => {
    const text = [
      claudeLine({ id: 'early', timestamp: '2026-07-01T09:00:00.000Z' }),
      claudeLine({ id: 'late', timestamp: '2026-07-01T12:00:00.000Z' })
    ].join('\n');

    const windowed = parseClaudeTranscript(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(windowed.messages).toBe(1);
    expect(windowed.tokensOut).toBe(50);
  });

  it('reports every model seen and attributes the most-used one', () => {
    const text = [
      claudeLine({ id: 'a', model: 'claude-sonnet-5' }),
      claudeLine({ id: 'b', model: 'claude-opus-5' }),
      claudeLine({ id: 'c', model: 'claude-opus-5' })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result.model).toBe('claude-opus-5');
    expect(result.models.sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });

  it('ignores negative or non-numeric token values', () => {
    // Build the usage block directly — the fixture helper's `??` defaults would
    // swallow an explicit null before it reached the parser.
    const text = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        usage: {
          input_tokens: -5,
          output_tokens: 'lots',
          cache_read_input_tokens: null,
          cache_creation_input_tokens: 10
        }
      }
    });
    const result = parseClaudeTranscript(text);
    expect(result).toMatchObject({ tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 10 });
  });
});

const codexMeta = (cwd = '/work/example-repo') => JSON.stringify({
  timestamp: '2026-07-01T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'rollout-abc', cwd, cli_version: '0.0.0', originator: 'codex_cli_rs', model: 'gpt-5.3-codex' }
});

const codexTokenCount = ({ timestamp, input, cached, output, reasoning = 0 }) => JSON.stringify({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output
      },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }
    }
  }
});

describe('parseCodexRollout', () => {
  // total_token_usage is CUMULATIVE and its events repeat verbatim — summing
  // either the totals or the per-turn `last` blocks over-counts badly.
  it('takes the final cumulative total rather than summing repeated events', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      codexTokenCount({ timestamp: '2026-07-01T10:00:02.000Z', input: 1000, cached: 800, output: 100 }),
      codexTokenCount({ timestamp: '2026-07-01T10:00:03.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    const result = parseCodexRollout(text);
    // input_tokens INCLUDES the cached portion, so uncached input is 3000-2400.
    expect(result).toMatchObject({
      sessionId: 'rollout-abc',
      cwd: '/work/example-repo',
      model: 'gpt-5.3-codex',
      tokensIn: 600,
      cacheReadTokens: 2400,
      tokensOut: 250,
      cacheWriteTokens: 0
    });
  });

  it('windows by taking the delta from the last pre-window total', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T09:00:00.000Z', input: 1000, cached: 800, output: 100 }),
      codexTokenCount({ timestamp: '2026-07-01T12:00:00.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    // A rollout spanning two PortOS runs bills each only its own increment.
    const result = parseCodexRollout(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(result.tokensOut).toBe(150);          // 250 - 100
    expect(result.cacheReadTokens).toBe(1600);   // 2400 - 800
    expect(result.tokensIn).toBe(400);           // (3000-2400) - (1000-800)
  });

  it('tolerates a truncated final line', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      '{"timestamp":"2026-07-01T10:00:02.000Z","type":"event_msg","payload":{"type":"token_c'
    ].join('\n');

    const result = parseCodexRollout(text);
    expect(result.tokensOut).toBe(100);
    expect(result.sessionId).toBe('rollout-abc');
  });

  it('returns zeroes for a rollout with no token_count events', () => {
    const result = parseCodexRollout(codexMeta());
    expect(result).toMatchObject({ messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 });
    // Metadata is still recovered so the caller can match on cwd.
    expect(result.cwd).toBe('/work/example-repo');
    expect(totalTranscriptTokens(result)).toBe(0);
  });

  it('ignores unknown line and payload types', () => {
    const text = [
      codexMeta(),
      JSON.stringify({ timestamp: '2026-07-01T10:00:01.000Z', type: 'brand_new_type', payload: { type: 'whatever', info: { total_token_usage: { input_tokens: 999999 } } } }),
      JSON.stringify({ timestamp: '2026-07-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
      codexTokenCount({ timestamp: '2026-07-01T10:00:03.000Z', input: 500, cached: 0, output: 20 })
    ].join('\n');

    const result = parseCodexRollout(text);
    expect(result.tokensIn).toBe(500);
    expect(result.tokensOut).toBe(20);
    expect(result.messages).toBe(1); // the one agent_message
  });

  it('handles an empty file', () => {
    expect(parseCodexRollout('')).toMatchObject({ sessionId: null, tokensIn: 0, tokensOut: 0 });
  });

  it('never returns a negative delta when a total appears to regress', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T09:00:00.000Z', input: 5000, cached: 4000, output: 500 }),
      codexTokenCount({ timestamp: '2026-07-01T12:00:00.000Z', input: 1000, cached: 800, output: 100 })
    ].join('\n');

    const result = parseCodexRollout(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
  });
});

describe('totalTranscriptTokens', () => {
  it('sums every billable bucket', () => {
    expect(totalTranscriptTokens({ tokensIn: 1, tokensOut: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })).toBe(10);
  });

  it('treats missing buckets as zero', () => {
    expect(totalTranscriptTokens({})).toBe(0);
    expect(totalTranscriptTokens(null)).toBe(0);
  });
});

describe('windowing excludes un-placeable messages', () => {
  // A line with no readable timestamp can't be placed in any run. Accepting it
  // under a bounded window would hand the same tokens to EVERY run that reads
  // the file — one unparseable line becoming permanent double-billing.
  it('excludes a timestamp-less Claude message when a window is supplied', () => {
    const noTs = JSON.parse(claudeLine({ id: 'no-ts' }));
    delete noTs.timestamp;
    const text = [
      JSON.stringify(noTs),
      claudeLine({ id: 'in-window', timestamp: '2026-07-01T10:05:00.000Z' })
    ].join('\n');

    const windowed = parseClaudeTranscript(text, {
      from: Date.parse('2026-07-01T10:00:00.000Z'),
      to: Date.parse('2026-07-01T10:10:00.000Z')
    });
    expect(windowed.messages).toBe(1);
    expect(windowed.tokensOut).toBe(50);
  });

  it('still counts a timestamp-less message on an UNBOUNDED read', () => {
    const noTs = JSON.parse(claudeLine({ id: 'no-ts' }));
    delete noTs.timestamp;
    // No window means no other run to double-count against, so keeping it is
    // strictly better than dropping real tokens.
    expect(parseClaudeTranscript(JSON.stringify(noTs)).messages).toBe(1);
  });

  it('windows Codex agent_message counts alongside the token delta', () => {
    const text = [
      codexMeta(),
      JSON.stringify({ timestamp: '2026-07-01T09:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'earlier run' } }),
      codexTokenCount({ timestamp: '2026-07-01T09:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      JSON.stringify({ timestamp: '2026-07-01T12:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'this run' } }),
      codexTokenCount({ timestamp: '2026-07-01T12:00:01.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    // The later run's tokens are a delta, so its message count must be too —
    // otherwise it also claims the earlier run's messages.
    const result = parseCodexRollout(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(result.messages).toBe(1);
    expect(result.tokensOut).toBe(150);
  });

  it('excludes a timestamp-less Codex token_count snapshot when a window is supplied', () => {
    const text = [
      codexMeta(),
      // In-window snapshot this run should bill.
      codexTokenCount({ timestamp: '2026-07-01T12:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      // A later snapshot with NO timestamp — outside this run's window in
      // reality, but unplaceable. Falling through to `latest` (the bug) would
      // fold its bigger cumulative total into this run instead of the run
      // that actually produced it.
      codexTokenCount({ timestamp: undefined, input: 9000, cached: 8000, output: 900 })
    ].join('\n');

    const result = parseCodexRollout(text, {
      from: Date.parse('2026-07-01T11:00:00.000Z'),
      to: Date.parse('2026-07-01T13:00:00.000Z')
    });
    expect(result.tokensOut).toBe(100);
  });
});

describe('per-model token buckets', () => {
  it('splits a model switch into per-model buckets that sum to the totals', () => {
    const text = [
      claudeLine({ id: 'a', model: 'claude-opus-5', output: 50, cacheRead: 1000, input: 10, cacheWrite: 100 }),
      claudeLine({ id: 'b', model: 'claude-haiku-4-5', output: 25, cacheRead: 500, input: 5, cacheWrite: 20 })
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(Object.keys(result.byModel).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5']);
    expect(result.byModel['claude-opus-5']).toMatchObject({ messages: 1, tokensOut: 50, cacheReadTokens: 1000, cacheWriteTokens: 100 });
    expect(result.byModel['claude-haiku-4-5']).toMatchObject({ messages: 1, tokensOut: 25, cacheReadTokens: 500, cacheWriteTokens: 20 });
    // No tokens invented or lost by the split.
    const sum = (field) => Object.values(result.byModel).reduce((s, b) => s + b[field], 0);
    expect(sum('tokensOut')).toBe(result.tokensOut);
    expect(sum('tokensIn')).toBe(result.tokensIn);
    expect(sum('cacheReadTokens')).toBe(result.cacheReadTokens);
    expect(sum('cacheWriteTokens')).toBe(result.cacheWriteTokens);
  });

  it('mirrors the Codex rollout total into byModel for shape parity', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    const result = parseCodexRollout(text);
    expect(result.byModel['gpt-5.3-codex']).toMatchObject({
      tokensIn: 600, cacheReadTokens: 2400, tokensOut: 250, cacheWriteTokens: 0
    });
  });
});

describe('no billable tokens are dropped from byModel', () => {
  // Callers price from `byModel`, so a billable message whose line carries no
  // `message.model` must still get a bucket — otherwise its tokens vanish from
  // the recorded total (measured: 500 output tokens lost on a 2-message file).
  it('buckets a model-less message under UNKNOWN_MODEL', () => {
    const noModel = JSON.parse(claudeLine({ id: 'm2', output: 500, cacheRead: 2000, input: 5, cacheWrite: 0 }));
    delete noModel.message.model;
    const text = [
      claudeLine({ id: 'm1', model: 'claude-opus-5', output: 100, cacheRead: 1000, input: 10, cacheWrite: 0 }),
      JSON.stringify(noModel)
    ].join('\n');

    const result = parseClaudeTranscript(text);
    expect(result.byModel[UNKNOWN_MODEL]).toMatchObject({ tokensOut: 500, cacheReadTokens: 2000 });
    // byModel must account for the whole aggregate — nothing dropped.
    const sum = (f) => Object.values(result.byModel).reduce((s, b) => s + b[f], 0);
    expect(sum('tokensOut')).toBe(result.tokensOut);
    expect(sum('tokensIn')).toBe(result.tokensIn);
    expect(sum('cacheReadTokens')).toBe(result.cacheReadTokens);
    expect(sum('messages')).toBe(result.messages);
  });

  // A Codex rollout whose session_meta/turn_context never named a model used
  // to return byModel: {} despite nonzero totals — invisible to
  // reconcileRunUsage's per-model billing path once a NAMED-model rollout
  // shared the same run window, silently dropping this rollout's tokens.
  it('buckets a model-less Codex rollout under UNKNOWN_MODEL instead of an empty byModel', () => {
    const metaNoModel = JSON.stringify({
      timestamp: '2026-07-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'rollout-no-model', cwd: '/work/example-repo', cli_version: '0.0.0' }
    });
    const text = [
      metaNoModel,
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    const result = parseCodexRollout(text);
    expect(result.model).toBeNull();
    expect(Object.keys(result.byModel)).toEqual([UNKNOWN_MODEL]);
    expect(result.byModel[UNKNOWN_MODEL]).toMatchObject({ tokensOut: 250, cacheReadTokens: 2400 });
  });
});

describe('Codex message count under a window', () => {
  // Synthesizing a message for a bounded read would inflate every later
  // overlapping run's message total.
  it('keeps zero when the window contains a token delta but no agent_message', () => {
    const text = [
      codexMeta(),
      JSON.stringify({ timestamp: '2026-07-01T09:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'before the window' } }),
      codexTokenCount({ timestamp: '2026-07-01T09:00:01.000Z', input: 1000, cached: 800, output: 100 }),
      codexTokenCount({ timestamp: '2026-07-01T12:00:00.000Z', input: 3000, cached: 2400, output: 250 })
    ].join('\n');

    const result = parseCodexRollout(text, { from: Date.parse('2026-07-01T11:00:00.000Z') });
    expect(result.messages).toBe(0);
    expect(result.tokensOut).toBe(150); // the delta is still billed
  });

  it('still synthesizes one on an unbounded read that produced tokens', () => {
    const text = [
      codexMeta(),
      codexTokenCount({ timestamp: '2026-07-01T10:00:01.000Z', input: 1000, cached: 0, output: 60 })
    ].join('\n');
    expect(parseCodexRollout(text).messages).toBe(1);
  });
});

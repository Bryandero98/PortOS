/**
 * The OpenAI-compatible chat-stream helpers, extracted from
 * `services/localLlmPlayground.js` so a bare loopback daemon (llama.cpp, MTPLX,
 * vLLM) can be measured without a provider record.
 *
 * `streamOpenAiChat` itself is exercised end-to-end through its two callers'
 * suites; what is worth pinning here are the pure decisions inside the read
 * loop — a malformed frame must SKIP rather than abort the stream, and a
 * reasoning-only model must still surface its output.
 */

import { describe, it, expect } from 'vitest';
import { buildMessages, extractStreamDelta, resolvePartialOutput } from './openAiChatStream.js';

describe('buildMessages', () => {
  it('omits the system message when blank', () => {
    expect(buildMessages({ systemPrompt: '  ', prompt: 'hi' })).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });

  it('includes a system message when present', () => {
    expect(buildMessages({ systemPrompt: 'Be terse', prompt: 'hi' })).toEqual([
      { role: 'system', content: 'Be terse' },
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('extractStreamDelta', () => {
  it('parses an OpenAI-style content delta', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hi"}}]}';
    expect(extractStreamDelta(line)).toEqual({ content: 'Hi', reasoning: '' });
  });

  it('parses a reasoning delta', () => {
    const line = 'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}';
    expect(extractStreamDelta(line)).toEqual({ content: '', reasoning: 'thinking' });
  });

  it('skips non-data lines and the [DONE]/✅ sentinels', () => {
    expect(extractStreamDelta(': keep-alive')).toBeNull();
    expect(extractStreamDelta('data: [DONE]')).toBeNull();
    expect(extractStreamDelta('data: ✅')).toBeNull();
    expect(extractStreamDelta('')).toBeNull();
  });

  it('skips a malformed frame instead of throwing (one bad frame must not abort the stream)', () => {
    expect(extractStreamDelta('data: {not json')).toBeNull();
  });

  it('tolerates a frame with no delta', () => {
    expect(extractStreamDelta('data: {"choices":[{}]}')).toEqual({ content: '', reasoning: '' });
  });
});

describe('resolvePartialOutput', () => {
  it('prefers visible content over reasoning', () => {
    expect(resolvePartialOutput({ output: 'hello', reasoning: 'thinking' })).toBe('hello');
  });

  it('falls back to reasoning when no content streamed', () => {
    expect(resolvePartialOutput({ output: '   ', reasoning: 'partial thought' })).toBe('partial thought');
  });

  it('returns empty string when neither content nor reasoning streamed', () => {
    expect(resolvePartialOutput({ output: '', reasoning: '' })).toBe('');
    expect(resolvePartialOutput({})).toBe('');
  });
});

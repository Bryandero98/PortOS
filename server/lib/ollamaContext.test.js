import { describe, it, expect } from 'vitest'
import {
  OLLAMA_AGENT_MIN_CONTEXT,
  OLLAMA_CONTEXT_ENV_VAR,
  describeOllamaContextOverflow,
  describeOllamaContextTooSmall,
  isSameOllamaDaemon,
  parseOllamaContextOverflow,
  resolveOllamaContextLength,
  withOllamaContextEnv
} from './ollamaContext.js'

describe('resolveOllamaContextLength', () => {
  it('prefers the provider numCtx over the ambient env', () => {
    expect(resolveOllamaContextLength({ numCtx: 131072 }, { [OLLAMA_CONTEXT_ENV_VAR]: '32768' })).toBe(131072)
  })

  it('falls back to OLLAMA_CONTEXT_LENGTH', () => {
    expect(resolveOllamaContextLength({}, { [OLLAMA_CONTEXT_ENV_VAR]: '65536' })).toBe(65536)
  })

  it('returns null when neither is set, so Ollama keeps its VRAM auto-pick', () => {
    expect(resolveOllamaContextLength({}, {})).toBeNull()
    expect(resolveOllamaContextLength(null, {})).toBeNull()
  })

  it('ignores zero, negative, and non-numeric values', () => {
    expect(resolveOllamaContextLength({ numCtx: 0 }, {})).toBeNull()
    expect(resolveOllamaContextLength({ numCtx: -1 }, {})).toBeNull()
    expect(resolveOllamaContextLength({ numCtx: 'wide' }, {})).toBeNull()
    expect(resolveOllamaContextLength({}, { [OLLAMA_CONTEXT_ENV_VAR]: 'wide' })).toBeNull()
  })

  it('falls through a non-numeric provider value to the env', () => {
    expect(resolveOllamaContextLength({ numCtx: null }, { [OLLAMA_CONTEXT_ENV_VAR]: '65536' })).toBe(65536)
  })
})

describe('withOllamaContextEnv', () => {
  it('injects the window as a string', () => {
    expect(withOllamaContextEnv({ PATH: '/bin' }, 131072)).toEqual({
      PATH: '/bin',
      [OLLAMA_CONTEXT_ENV_VAR]: '131072'
    })
  })

  it('leaves the env untouched when no window is configured', () => {
    const env = { PATH: '/bin' }
    expect(withOllamaContextEnv(env, null)).toBe(env)
    expect(withOllamaContextEnv(env, 0)).toBe(env)
  })

  it('does not mutate the source env', () => {
    const env = { PATH: '/bin' }
    withOllamaContextEnv(env, 65536)
    expect(env[OLLAMA_CONTEXT_ENV_VAR]).toBeUndefined()
  })
})

describe('parseOllamaContextOverflow', () => {
  const body = '{"error":{"code":400,"message":"request (32768 tokens) exceeds the available context size ' +
    '(32768 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":32768,"n_ctx":32768}}'

  it('reads both token counts out of the full error body', () => {
    expect(parseOllamaContextOverflow(body)).toEqual({ promptTokens: 32768, contextLength: 32768 })
  })

  it('reads them from the human message alone', () => {
    expect(parseOllamaContextOverflow('request (40000 tokens) exceeds the available context size (32768 tokens)'))
      .toEqual({ promptTokens: 40000, contextLength: 32768 })
  })

  it('recognizes the error type even when the message was reflowed away', () => {
    expect(parseOllamaContextOverflow('"type":"exceed_context_size_error","n_prompt_tokens":9000,"n_ctx":8192}}'))
      .toEqual({ promptTokens: 9000, contextLength: 8192 })
  })

  it('reports nulls rather than failing when only the type survives', () => {
    expect(parseOllamaContextOverflow('exceed_context_size_error')).toEqual({ promptTokens: null, contextLength: null })
  })

  it('returns null for unrelated output', () => {
    expect(parseOllamaContextOverflow('API Error: 400 bad request')).toBeNull()
    expect(parseOllamaContextOverflow('')).toBeNull()
    expect(parseOllamaContextOverflow(null)).toBeNull()
  })
})

describe('overflow descriptions', () => {
  it('names the knob that actually fixes the overflow', () => {
    const text = describeOllamaContextOverflow({ promptTokens: 32768, contextLength: 32768 }, { model: 'qwen3.8:27b' })
    expect(text).toContain('qwen3.8:27b')
    expect(text).toContain('32K')
    expect(text).toContain('num_ctx')
  })

  it('degrades to "unknown" instead of NaN when the counts did not parse', () => {
    const text = describeOllamaContextOverflow({ promptTokens: null, contextLength: null })
    expect(text).toContain('unknown')
    expect(text).not.toContain('NaN')
  })

  it('warns with the agent floor when the daemon window is too small', () => {
    const text = describeOllamaContextTooSmall(32768, { providerName: 'Claude Ollama TUI' })
    expect(text).toContain('Claude Ollama TUI')
    expect(text).toContain('32K')
    expect(text).toContain(`${OLLAMA_AGENT_MIN_CONTEXT / 1024}K`)
  })
})

describe('isSameOllamaDaemon', () => {
  it('matches across scheme and /v1 spelling differences', () => {
    expect(isSameOllamaDaemon('http://localhost:11434/v1', 'http://localhost:11434')).toBe(true)
    expect(isSameOllamaDaemon('localhost:11434', 'http://localhost:11434')).toBe(true)
    expect(isSameOllamaDaemon('https://LOCALHOST:11434/', 'http://localhost:11434')).toBe(true)
  })

  it('matches loopback aliases, including IPv6 and an empty OLLAMA_HOST hostname', () => {
    expect(isSameOllamaDaemon('http://127.0.0.1:11434', 'http://localhost:11434')).toBe(true)
    expect(isSameOllamaDaemon('http://[::1]:11434/v1', 'http://localhost:11434')).toBe(true)
    expect(isSameOllamaDaemon(':11434', 'http://localhost:11434')).toBe(true)
    expect(isSameOllamaDaemon('http://:11434', 'http://127.0.0.1:11434')).toBe(true)
  })

  it('rejects a different host or port — PortOS only manages the daemon it points at', () => {
    expect(isSameOllamaDaemon('http://192.0.2.10:11434', 'http://localhost:11434')).toBe(false)
    expect(isSameOllamaDaemon('http://localhost:11435', 'http://localhost:11434')).toBe(false)
  })

  it('is false when either side is missing or unparseable, so nothing ambiguous authorizes a restart', () => {
    expect(isSameOllamaDaemon('', 'http://localhost:11434')).toBe(false)
    expect(isSameOllamaDaemon('http://localhost:11434', null)).toBe(false)
    expect(isSameOllamaDaemon('http://', 'http://localhost:11434')).toBe(false)
  })
})

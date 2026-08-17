import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./ollamaManager.js', () => ({
  ensureContextWindow: vi.fn(),
  getRuntimeContextLength: vi.fn(),
  getBaseUrl: vi.fn(() => 'http://localhost:11434')
}))

import { ensureContextWindow, getRuntimeContextLength } from './ollamaManager.js'
import { ensureOllamaAgentContext } from './ollamaAgentContext.js'

const claudeOllamaTui = {
  id: 'claude-ollama-tui',
  name: 'Claude Ollama TUI (local model)',
  type: 'tui',
  ollamaBacked: true,
  envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' }
}

describe('ensureOllamaAgentContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('skips providers that are not Ollama-backed', async () => {
    const result = await ensureOllamaAgentContext({ id: 'claude-code-tui', type: 'tui' }, { env: {} })
    expect(result).toEqual({ skipped: true })
    expect(ensureContextWindow).not.toHaveBeenCalled()
    expect(getRuntimeContextLength).not.toHaveBeenCalled()
  })

  it('skips a null provider', async () => {
    expect(await ensureOllamaAgentContext(null, { env: {} })).toEqual({ skipped: true })
  })

  // ollamaManager only ever manages the LOCAL daemon, so reloading it for a
  // provider served by another host would disrupt unrelated local work and still
  // leave that provider's real daemon at its old window.
  it('skips a provider pointed at a remote Ollama host', async () => {
    const remote = { ...claudeOllamaTui, numCtx: 131072, envVars: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:11434' } }
    expect(await ensureOllamaAgentContext(remote, { env: {} })).toEqual({ skipped: true, reason: 'remote-daemon' })
    expect(ensureContextWindow).not.toHaveBeenCalled()
    expect(getRuntimeContextLength).not.toHaveBeenCalled()
  })

  it('holds the daemon at the provider window', async () => {
    ensureContextWindow.mockResolvedValue({ applied: true, reason: 'restarted' })
    const result = await ensureOllamaAgentContext({ ...claudeOllamaTui, numCtx: 131072 }, { env: {} })
    expect(ensureContextWindow).toHaveBeenCalledWith(131072)
    expect(result).toMatchObject({ skipped: false, contextLength: 131072, applied: true, warning: null })
  })

  it('passes the selected model through to runtime context management', async () => {
    ensureContextWindow.mockResolvedValue({ applied: true, reason: 'restarted' })
    await ensureOllamaAgentContext({ ...claudeOllamaTui, numCtx: 131072 }, { env: {}, model: 'small-model' })
    expect(ensureContextWindow).toHaveBeenCalledWith(131072, 'small-model')
  })

  it('warns but does not block the spawn when the reload fails', async () => {
    ensureContextWindow.mockResolvedValue({ applied: false, reason: 'stop-failed', error: 'still reachable' })
    const result = await ensureOllamaAgentContext({ ...claudeOllamaTui, numCtx: 131072 }, { env: {} })
    expect(result.applied).toBe(false)
    expect(result.warning).toContain('131072')
    expect(result.warning).toContain('still reachable')
  })

  it('warns when no window is configured and the daemon is running below the agent floor', async () => {
    getRuntimeContextLength.mockResolvedValue(32768)
    const result = await ensureOllamaAgentContext(claudeOllamaTui, { env: {} })
    expect(ensureContextWindow).not.toHaveBeenCalled()
    expect(result.warning).toContain('32K')
    expect(result.warning).toContain('num_ctx')
  })

  it('stays quiet when the running window is already generous', async () => {
    getRuntimeContextLength.mockResolvedValue(262144)
    expect((await ensureOllamaAgentContext(claudeOllamaTui, { env: {} })).warning).toBeNull()
  })

  it('stays quiet when no model is resident — an unknown window is not evidence of a small one', async () => {
    getRuntimeContextLength.mockResolvedValue(null)
    expect((await ensureOllamaAgentContext(claudeOllamaTui, { env: {} })).warning).toBeNull()
  })

  it('falls back to OLLAMA_CONTEXT_LENGTH when the provider carries no numCtx', async () => {
    ensureContextWindow.mockResolvedValue({ applied: false, reason: 'already-large-enough' })
    await ensureOllamaAgentContext(claudeOllamaTui, { env: { OLLAMA_CONTEXT_LENGTH: '65536' } })
    expect(ensureContextWindow).toHaveBeenCalledWith(65536)
  })
})

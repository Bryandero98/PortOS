/**
 * Pre-spawn context-window preparation for Ollama-backed *agent harnesses*
 * (`claude-ollama`, `claude-ollama-tui`, `opencode-ollama`, …).
 *
 * These providers launch a real CLI/TUI that speaks to Ollama directly, so —
 * unlike `api`-type providers, where the toolkit runner attaches a per-request
 * `num_ctx` — PortOS has no way to influence the window from inside the
 * request. The only lever is the daemon's `OLLAMA_CONTEXT_LENGTH`, which is why
 * a provider's `numCtx` is enforced here by (re)loading the daemon at that
 * window before the harness starts.
 *
 * When the provider carries no `numCtx`, nothing is restarted — Ollama's
 * VRAM-based auto-pick stands — but a too-small window is warned about up
 * front, because the alternative is a run that dies an hour in with
 * `exceed_context_size_error`.
 */

import { isOllamaBackedProvider } from './providers.js'
// Straight from `internal/` on purpose: it is deliberately NOT re-exported from
// providers.js, and re-deriving the normalization here is exactly the drift that
// exclusion exists to prevent.
import { ollamaBaseFromProvider } from '../lib/aiToolkit/internal/ollamaBacked.js'
import {
  OLLAMA_AGENT_MIN_CONTEXT,
  describeOllamaContextTooSmall,
  isSameOllamaDaemon,
  resolveOllamaContextLength
} from '../lib/ollamaContext.js'
import { ensureContextWindow, getBaseUrl, getRuntimeContextLength } from './ollamaManager.js'

/**
 * Prepare the Ollama daemon for an agent harness run.
 *
 * Never throws and never blocks a spawn: a daemon that refuses to restart is
 * reported through `warning` (and the run proceeds on whatever window it has)
 * rather than failing the agent before it starts.
 *
 * Non-Ollama providers return `{ skipped: true }`. Call sites gate on
 * `isOllamaBackedProvider` too, so a cloud run takes no async hop at all; this
 * guard is the module's own contract, not the hot path.
 *
 * @param {{id?:string, name?:string, numCtx?:number|null, envVars?:object, endpoint?:string, ollamaBacked?:boolean}|null} provider
 * @param {{ env?: Record<string, string|undefined> }} [options]
 * @returns {Promise<{ skipped: boolean, contextLength?: number|null, applied?: boolean, warning?: string|null }>}
 */
export async function ensureOllamaAgentContext(provider, { env = process.env } = {}) {
  if (!provider || !isOllamaBackedProvider(provider)) return { skipped: true }
  // A provider can point at a REMOTE Ollama host. `ollamaManager` only ever
  // starts, stops, and inspects the local daemon, so acting on one of those
  // would reload an unrelated local daemon and still leave the provider's real
  // daemon at its old window.
  if (!isSameOllamaDaemon(ollamaBaseFromProvider(provider), getBaseUrl())) {
    return { skipped: true, reason: 'remote-daemon' }
  }

  const contextLength = resolveOllamaContextLength(provider, env)
  const providerName = provider.name || provider.id || null

  if (!contextLength) {
    const runtime = await getRuntimeContextLength().catch(() => null)
    const warning = runtime != null && runtime < OLLAMA_AGENT_MIN_CONTEXT
      ? describeOllamaContextTooSmall(runtime, { providerName })
      : null
    if (warning) console.warn(warning)
    return { skipped: false, contextLength: null, applied: false, warning }
  }

  const result = await ensureContextWindow(contextLength).catch((err) => ({
    applied: false, reason: 'error', error: err.message
  }))
  const warning = result.error
    ? `⚠️ Could not reload Ollama at a ${contextLength}-token window (${result.error}) — ${providerName || 'the run'} continues on the current window.`
    : null
  if (warning) console.warn(warning)
  return { skipped: false, contextLength, applied: !!result.applied, warning }
}

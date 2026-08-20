/**
 * One AI-provider card on the Settings → AI Providers page.
 *
 * Lives here rather than inline on the page because the page also owns the
 * provider EDITOR, the sample-provider panel and the ad-hoc runner — the card
 * is ~250 lines of its own and was already three `map`s deep once the page
 * started grouping cards by readiness.
 *
 * The card renders no derivation of its own: `readiness`, `runtime` and
 * `status` all arrive resolved, so what colors the border, what the badge says,
 * and which section the page filed the card under can never disagree.
 */

import {
  PROVIDER_READINESS,
  effectiveModelContextWindow,
  isApiProvider,
  isGrokBuildCli,
  isLocalEndpoint,
  isOrcaRouterBackedProvider,
  isProcessProvider,
  isRunnerAllowedCommand,
  isTuiProvider,
  providerTypeClass,
  supportsModelRefresh,
} from '../../utils/providers';
import { formatContextLength } from '../../utils/formatters';
import ProviderRuntimeStatus from './ProviderRuntimeStatus';
import { GrokUploadWarning, OrcaRouterKeyHint } from './ProviderNotices';

// One phrasing for "this command isn't on the CoS Agent Runner's allowlist".
// The editor states the same thing in its own inline banner, in prose.
const RUNNER_NOT_ALLOWED_HINT = 'This command is not on the CoS Agent Runner’s allowlist, so /spawn and /spawn-tui will refuse it. The provider still works everywhere else (direct spawn, chat, pipeline). The allowlist is curated in the PortOS source, not in this form.';

// Card presentation per readiness state. Exactly ONE border-color utility is
// emitted per card — Tailwind resolves same-specificity color utilities by
// stylesheet order, not by the order they appear in `className` — so the
// "default provider" highlight is a ring rather than a competing border color.
export const READINESS_STYLES = {
  [PROVIDER_READINESS.READY]: {
    label: 'READY',
    border: 'border-port-success/40',
    badge: 'bg-port-success/20 text-port-success',
    hint: 'Enabled, and every prerequisite is in place.',
  },
  [PROVIDER_READINESS.BENCHED]: {
    label: 'BENCHED',
    border: 'border-port-error/50',
    badge: 'bg-port-error/20 text-port-error',
    hint: 'Enabled, but benched after a failure — calls route to the fallback.',
  },
  [PROVIDER_READINESS.BLOCKED]: {
    label: 'NEEDS SETUP',
    border: 'border-port-warning/50',
    badge: 'bg-port-warning/20 text-port-warning',
    hint: 'Missing a prerequisite — install the CLI or add the API key to use it.',
  },
  [PROVIDER_READINESS.DISABLED]: {
    label: 'DISABLED',
    border: 'border-port-border',
    badge: 'bg-gray-500/20 text-gray-400',
    // Switched-off cards recede until hovered, so a long list reads as the
    // handful of providers that are actually live.
    dim: 'opacity-70 hover:opacity-100 transition-opacity',
    hint: 'Ready to go, but switched off.',
  },
};

export default function ProviderCard({
  provider,
  readiness,
  runtime,
  status,
  isDefault,
  providersById,
  runnerAllowedCommands,
  testResult,
  refreshing,
  recovering,
  onTest,
  onRefreshModels,
  onToggleEnabled,
  onSetActive,
  onEdit,
  onDelete,
  onRecover,
  onInstallRuntime,
}) {
  const style = READINESS_STYLES[readiness.state];
  return (
    <div
      className={`bg-port-card border border-l-4 rounded-xl p-4 ${style.border} ${style.dim || ''} ${
        isDefault ? 'ring-1 ring-port-accent/60' : ''
      }`}
    >
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-white">{provider.name}</h3>
            <span className={`text-xs px-2 py-0.5 rounded ${providerTypeClass(provider.type)}`}>
              {provider.type.toUpperCase()}
            </span>
            {isDefault && (
              <span className="text-xs px-2 py-0.5 rounded bg-port-accent/20 text-port-accent">
                DEFAULT
              </span>
            )}
            {provider.llamaBacked && (
              <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                LLAMA.CPP / DFLASH
              </span>
            )}
            {provider.mtplxBacked && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                MTPLX
              </span>
            )}
            {/* One badge for the card's readiness — the same state that
                colors its border and decides which section it sits in.
                BENCHED covers what used to render as UNAVAILABLE: an
                enabled provider sidelined after a failure (usage limit,
                model-not-found, auth) in favor of its fallback. */}
            <span
              className={`text-xs px-2 py-0.5 rounded ${style.badge}`}
              title={readiness.state === PROVIDER_READINESS.BLOCKED
                ? readiness.missing.map(m => m.label).join(' · ')
                : (status?.message || style.hint)}
            >
              {style.label}
              {readiness.state === PROVIDER_READINESS.BENCHED && status?.reason
                ? ` · ${status.reason}`
                : ''}
            </span>
            {/* A blocked provider's toggle is not what's stopping it, so
                spell out which way it sits rather than leaving the reader
                to infer it from the Enable/Disable button. */}
            {readiness.state === PROVIDER_READINESS.BLOCKED && (
              <span className="text-xs px-2 py-0.5 rounded bg-gray-500/20 text-gray-400">
                {provider.enabled ? 'SWITCHED ON' : 'SWITCHED OFF'}
              </span>
            )}
            {/* Off the CoS Agent Runner's exec allowlist: the provider still
                works for direct spawn, it just can't be launched by /spawn
                or /spawn-tui. Informational — never a save-time rejection. */}
            {isProcessProvider(provider) && isRunnerAllowedCommand(provider.command, runnerAllowedCommands) === false && (
              <span
                className="text-xs px-2 py-0.5 rounded bg-port-warning/20 text-port-warning"
                title={RUNNER_NOT_ALLOWED_HINT}
              >
                NO AGENT RUNNER
              </span>
            )}
          </div>

          <ProviderRuntimeStatus
            className="mt-2"
            runtime={runtime}
            onInstall={onInstallRuntime}
          />

          {provider.enabled && status?.available === false && (
            <div className="mt-2 text-xs rounded border border-port-error/40 bg-port-error/10 px-3 py-2 text-port-error space-y-1">
              <p className="break-words">
                <span className="font-semibold">Benched ({status?.reason || 'unknown'})</span>
                {status?.timeUntilRecovery ? ` — auto-retries in ${status.timeUntilRecovery}` : ''}
                . Calls route to the fallback until then.
              </p>
              {status?.message && (
                <p className="break-words text-port-error/80">Why: {status.message}</p>
              )}
              <button
                type="button"
                onClick={() => onRecover(provider.id)}
                disabled={recovering}
                className="mt-1 px-2 py-0.5 rounded bg-port-error/20 hover:bg-port-error/30 disabled:opacity-50 text-port-error"
              >
                {recovering ? 'Clearing…' : 'Recover now'}
              </button>
            </div>
          )}

          <div className="mt-2 text-sm text-gray-400 space-y-1">
            {provider.llamaBacked && (
              <p className="text-xs text-purple-300/90">
                Local llama.cpp / llama-server harness (endpoint: <code className="text-purple-200">{provider.endpoint}</code>) — supports DFlash 2 speculative drafting.
              </p>
            )}
            {isProcessProvider(provider) && (
              <p className="break-words">Command: <code className="text-gray-300 break-all">{provider.command} {provider.args?.join(' ')}</code></p>
            )}
            {isApiProvider(provider) && (
              <p className="break-words">Endpoint: <code className="text-gray-300 break-all">{provider.endpoint}</code></p>
            )}
            {/* API-type providers auth solely via the stored apiKey (sent as a
                Bearer header) — surface its state here so "where does the key
                go?" is answered from the card, not by spelunking the form. */}
            {isApiProvider(provider) && (
              provider.hasApiKey ? (
                <p className="text-xs">API key: <span className="text-port-success">set</span></p>
              ) : isLocalEndpoint(provider.endpoint) ? (
                <p className="text-xs">API key: <span className="text-gray-500">none (local endpoint)</span></p>
              ) : (
                <p className="text-xs">API key: <span className="text-port-warning">not set — Edit this provider to paste one</span></p>
              )
            )}
            {provider.models?.length > 0 && (
              <p>Models: {provider.models.slice(0, 3).join(', ')}{provider.models.length > 3 ? ` +${provider.models.length - 3}` : ''}</p>
            )}
            {provider.defaultModel && (
              <p className="break-words">Default: <code className="text-gray-300 break-all">{provider.defaultModel}</code></p>
            )}
            {provider.effort && (
              <p className="break-words">Default effort: <code className="text-gray-300">{provider.effort}</code></p>
            )}
            {(() => {
              const windowLabel = formatContextLength(effectiveModelContextWindow(provider, provider.defaultModel));
              return windowLabel ? (
                <p className="text-xs">
                  Context: <span className="text-gray-300">{windowLabel}</span>
                  {provider.contextWindow ? <span className="text-gray-500"> override</span> : null}
                </p>
              ) : null;
            })()}
            {(provider.lightModel || provider.mediumModel || provider.heavyModel) && (
              <p className="text-xs">
                Tiers:
                {provider.lightModel && <span className="ml-1 text-port-success">{provider.lightModel}</span>}
                {provider.mediumModel && <span className="ml-1 text-port-warning">{provider.mediumModel}</span>}
                {provider.heavyModel && <span className="ml-1 text-port-error">{provider.heavyModel}</span>}
              </p>
            )}
            {provider.headlessArgs?.length > 0 && (
              <p className="text-xs break-words">
                Headless: <code className="text-gray-300 break-all">{provider.headlessArgs.join(' ')}</code>
              </p>
            )}
            {isTuiProvider(provider) && (
              <p className="text-xs break-words">
                TUI: paste delay <span className="text-gray-300">{provider.tuiPromptDelayMs || 2500}ms</span>, completion by sentinel, process exit, or explicit failure
              </p>
            )}
            {provider.fallbackProvider && (
              <p className="text-xs">
                Fallback: <span className="text-port-accent">{providersById[provider.fallbackProvider]?.name || provider.fallbackProvider}</span>
                {provider.fallbackModel && <span className="ml-1 text-gray-300">({provider.fallbackModel})</span>}
              </p>
            )}
            {provider.envVars && Object.keys(provider.envVars).length > 0 && (
              <div className="text-xs mt-1">
                <span className="text-gray-400">Env:</span>
                {Object.entries(provider.envVars).map(([k, v]) => (
                  <div key={k}>
                    <code className="ml-1 text-orange-400">
                      {k}={provider.secretEnvVars?.includes(k) ? '***' : v}
                    </code>
                  </div>
                ))}
              </div>
            )}
          </div>

          {isGrokBuildCli(provider) && <GrokUploadWarning className="mt-2" />}

          {isOrcaRouterBackedProvider(provider) && (
            <OrcaRouterKeyHint
              sibling={providersById.orcarouter}
              onEdit={onEdit}
              className="mt-2"
            />
          )}

          {testResult && !testResult.testing && (
            <div className={`mt-2 text-sm ${testResult.success ? 'text-port-success' : 'text-port-error'}`}>
              {testResult.success
                ? `✓ Available${testResult.version ? ` (${testResult.version})` : ''}`
                : `✗ ${testResult.error}`
              }
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onTest(provider.id)}
            disabled={testResult?.testing}
            className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50"
          >
            {testResult?.testing ? 'Testing...' : 'Test'}
          </button>

          {supportsModelRefresh(provider) && (
            <button
              onClick={() => onRefreshModels(provider.id)}
              disabled={refreshing}
              className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh available models"
            >
              {refreshing ? 'Refreshing...' : 'Refresh Models'}
            </button>
          )}

          <button
            onClick={() => onToggleEnabled(provider)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              provider.enabled
                ? 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30'
                : 'bg-port-success/20 text-port-success hover:bg-port-success/30'
            }`}
          >
            {provider.enabled ? 'Disable' : 'Enable'}
          </button>

          {!isDefault && provider.enabled && (
            <button
              onClick={() => onSetActive(provider.id)}
              className="px-3 py-1.5 text-sm bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded transition-colors"
            >
              Set Default
            </button>
          )}

          <button
            onClick={() => onEdit(provider)}
            className="px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded transition-colors"
          >
            Edit
          </button>

          <button
            onClick={() => onDelete(provider.id)}
            className="px-3 py-1.5 text-sm bg-port-error/20 text-port-error hover:bg-port-error/30 rounded transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

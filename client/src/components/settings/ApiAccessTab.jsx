import { useState, useEffect, useCallback } from 'react';
import { Bot, Globe, Lock, Unlock, Copy, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { getSettings, updateSettings, getOpenApiSpec } from '../../services/apiSystem';
import { copyToClipboard } from '../../lib/clipboard';

// Mirror of server/lib/apiRegistry.js — the client can't import the server
// module, so the display metadata is duplicated here. The server stays the
// source of truth for gating; this only drives the UI cards. The OpenAPI spec
// (fetched below) is what actually reflects which paths exist per API.
const API_CARDS = [
  {
    id: 'voice',
    label: 'Voice / TTS',
    description: 'Text-to-speech synthesis and voice enumeration (Kokoro, Piper).',
    publicBase: '/api/voice/public',
    exampleCurl: (base) =>
      `curl -X POST ${base}/api/voice/public/synthesize \\\n` +
      `  -H 'content-type: application/json' \\\n` +
      `  -d '{"text":"Hello from PortOS","engine":"kokoro"}' \\\n` +
      `  --output speech.wav`,
  },
  {
    id: 'sdapi',
    label: 'Image Gen (A1111-compatible)',
    description: 'AUTOMATIC1111-compatible txt2img + model/sampler catalog. Also requires the "Expose A1111 API" toggle under Settings → Image Gen.',
    publicBase: '/sdapi/v1',
    exampleCurl: (base) =>
      `curl -X POST ${base}/sdapi/v1/txt2img \\\n` +
      `  -H 'content-type: application/json' \\\n` +
      `  -d '{"prompt":"a neon city","steps":20}'`,
  },
];

const DEFAULT_ACCESS = { exposed: false, requireAuth: false };
const DEFAULT_AGENT_CONTEXT = { enabled: false, profile: 'metadata', scopes: ['navigation', 'workspaces'] };
const AGENT_CONTEXT_SCOPES = [
  { id: 'navigation', label: 'Navigation', hint: 'PortOS page labels, aliases, and paths.' },
  { id: 'workspaces', label: 'Workspaces', hint: 'App presence and task counts; never repository paths or branches.' },
  { id: 'brain', label: 'Brain', hint: 'Searchable Brain records; metadata-only unless summary mode is selected.' },
  { id: 'identity', label: 'Identity export', hint: 'Section presence only; never raw identity records or Privacy Vault data.' },
];

const Toggle = ({ id, checked, onChange, label, hint, disabled }) => (
  <div className={`flex items-start gap-3 ${disabled ? 'opacity-50' : ''}`}>
    <input
      id={id}
      aria-label={label}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="w-4 h-4 mt-0.5 shrink-0"
    />
    <label htmlFor={id} className={`flex flex-col min-w-0 flex-1 ${disabled ? '' : 'cursor-pointer'}`}>
      <span className="text-sm text-white">{label}</span>
      {hint && <span className="text-xs text-gray-500">{hint}</span>}
    </label>
  </div>
);

export function ApiAccessTab() {
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [access, setAccess] = useState({});
  const [agentContext, setAgentContext] = useState(DEFAULT_AGENT_CONTEXT);
  const [spec, setSpec] = useState(null);

  // window.location.origin is the tailnet host the user is browsing from, so
  // the example curls are copy-pasteable from this machine.
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const loadSpec = useCallback(() => {
    getOpenApiSpec({ silent: true })
      .then(setSpec)
      .catch(() => setSpec(null));
  }, []);

  useEffect(() => {
    getSettings({ silent: true })
      .then((s) => {
        setAccess(s?.apiAccess || {});
        setAgentContext({
          ...DEFAULT_AGENT_CONTEXT,
          ...(s?.agentContext || {}),
          scopes: s?.agentContext?.scopes?.length ? s.agentContext.scopes : DEFAULT_AGENT_CONTEXT.scopes,
        });
      })
      .catch(() => toast.error('Failed to load API access settings'))
      .finally(() => setLoading(false));
    loadSpec();
  }, [loadSpec]);

  const entryFor = (id) => ({ ...DEFAULT_ACCESS, ...(access[id] || {}) });

  // Persist a single API's flags. Optimistic local update; revert on failure.
  const patchAccess = async (id, partial) => {
    const prev = entryFor(id);
    const next = { ...prev, ...partial };
    setAccess((a) => ({ ...a, [id]: next }));
    setSavingId(id);
    try {
      // PUT /api/settings shallow-merges only TOP-LEVEL keys, so sending just
      // `{ apiAccess: { [id]: next } }` would REPLACE the whole apiAccess object
      // and wipe the other API's persisted flags. Send the full merged map so
      // every API's entry survives.
      await updateSettings({ apiAccess: { ...access, [id]: next } }, { silent: true });
      loadSpec(); // exposed-set changed → refresh the documented paths
    } catch (err) {
      setAccess((a) => ({ ...a, [id]: prev })); // revert
      toast.error(`Failed to save: ${err.message}`);
    } finally {
      setSavingId(null);
    }
  };

  const patchAgentContext = async (partial) => {
    const prev = agentContext;
    const next = { ...prev, ...partial };
    setAgentContext(next);
    setSavingId('agent-context');
    try {
      await updateSettings({ agentContext: next }, { silent: true });
    } catch (err) {
      setAgentContext(prev);
      toast.error(`Failed to save: ${err.message}`);
    } finally {
      setSavingId(null);
    }
  };

  const patchAgentContextScope = (scope, checked) => {
    const scopes = checked
      ? [...new Set([...agentContext.scopes, scope])]
      : agentContext.scopes.filter((candidate) => candidate !== scope);
    if (scopes.length > 0) patchAgentContext({ scopes });
  };

  if (loading) return <BrailleSpinner text="Loading API access settings" />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-2">
        <div className="flex items-center gap-2 text-white">
          <Globe size={18} />
          <h2 className="text-lg font-semibold">API Access</h2>
        </div>
        <p className="text-xs text-gray-500">
          Expose individual PortOS services as HTTP APIs on your network. When you enable a
          PortOS password (Settings → Security), the whole app is gated by default — but an
          exposed API here can stay <strong>passwordless</strong> so other machines on your
          tailnet can call it. Toggle <em>Require auth</em> to gate a specific API behind the
          password while leaving the rest open. Only read/synthesis endpoints are public;
          config and control endpoints always require the password.
        </p>
      </div>

      {API_CARDS.map((card) => {
        const entry = entryFor(card.id);
        // Disable EVERY card's toggles while ANY save is in flight, not just
        // this card's. Each PUT sends a full apiAccess snapshot and the server
        // replaces the whole key, so two overlapping saves could let the older
        // one land last and clobber the newer toggle. Serializing to one save
        // at a time removes the race. `cardBusy` still drives this card's spinner.
        const cardBusy = savingId === card.id;
        const busy = savingId !== null;
        return (
          <div key={card.id} className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-white">
                  <h3 className="text-base font-semibold">{card.label}</h3>
                  {entry.exposed ? (
                    entry.requireAuth
                      ? <span className="inline-flex items-center gap-1 text-xs text-port-warning"><Lock size={12} /> auth required</span>
                      : <span className="inline-flex items-center gap-1 text-xs text-port-success"><Unlock size={12} /> passwordless</span>
                  ) : (
                    <span className="text-xs text-gray-500">not exposed</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-1">{card.description}</p>
              </div>
              {cardBusy && <BrailleSpinner />}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Toggle
                id={`api-${card.id}-exposed`}
                checked={entry.exposed}
                disabled={busy}
                onChange={(v) => patchAccess(card.id, { exposed: v })}
                label="Expose on the network"
                hint="Off by default. Nothing is reachable until you turn this on."
              />
              <Toggle
                id={`api-${card.id}-auth`}
                checked={entry.requireAuth}
                disabled={busy || !entry.exposed}
                onChange={(v) => patchAccess(card.id, { requireAuth: v })}
                label="Require auth (password)"
                hint="When off, this API is callable without the PortOS password."
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs text-gray-400">Public base URL</div>
              <code className="block bg-port-bg border border-port-border rounded-lg px-3 py-2 text-xs text-port-accent break-all">
                {baseUrl}{card.publicBase}
              </code>
            </div>

            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer select-none">Example request</summary>
              <div className="mt-2 relative">
                <pre className="bg-port-bg border border-port-border rounded-lg p-3 overflow-x-auto text-[11px] text-gray-300 whitespace-pre">
{card.exampleCurl(baseUrl)}
                </pre>
                <button
                  type="button"
                  onClick={() => copyToClipboard(card.exampleCurl(baseUrl), 'Example copied')}
                  className="absolute top-2 right-2 p-1.5 rounded bg-port-border hover:bg-port-border/70 text-white"
                  aria-label="Copy example request"
                  title="Copy example request"
                >
                  <Copy size={12} />
                </button>
              </div>
            </details>
          </div>
        );
      })}

      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-white">
              <Bot size={18} />
              <h3 className="text-base font-semibold">Agent Context (MCP)</h3>
              <span className={`text-xs ${agentContext.enabled ? 'text-port-success' : 'text-gray-500'}`}>
                {agentContext.enabled ? 'local access enabled' : 'disabled'}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              A read-only context surface for agents running on this machine. It accepts loopback
              connections only, never tailnet or public traffic, and makes no LLM calls. PortOS
              password authentication still applies when configured.
            </p>
          </div>
          {savingId === 'agent-context' && <BrailleSpinner />}
        </div>

        <Toggle
          id="agent-context-enabled"
          checked={agentContext.enabled}
          disabled={savingId !== null}
          onChange={(enabled) => patchAgentContext({ enabled })}
          label="Enable local MCP context"
          hint="Off by default. Enabling does not expose the endpoint beyond this machine."
        />

        <fieldset className="space-y-2" disabled={savingId !== null}>
          <legend className="text-xs font-medium text-gray-300 mb-2">Allowed context scopes</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {AGENT_CONTEXT_SCOPES.map((scope) => {
              const checked = agentContext.scopes.includes(scope.id);
              return (
                <Toggle
                  key={scope.id}
                  id={`agent-context-scope-${scope.id}`}
                  checked={checked}
                  disabled={savingId !== null || (checked && agentContext.scopes.length === 1)}
                  onChange={(value) => patchAgentContextScope(scope.id, value)}
                  label={scope.label}
                  hint={scope.hint}
                />
              );
            })}
          </div>
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="agent-context-profile" className="text-xs font-medium text-gray-300">Disclosure profile</label>
          <select
            id="agent-context-profile"
            value={agentContext.profile}
            disabled={savingId !== null}
            onChange={(event) => patchAgentContext({ profile: event.target.value })}
            className="block w-full sm:max-w-md bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            <option value="metadata">Metadata only (recommended)</option>
            <option value="summary">Redacted summaries</option>
          </select>
          <p className="text-xs text-gray-500">
            Metadata mode can match private text but returns only generic record labels and stable opaque references.
          </p>
        </div>

        <div className="space-y-1">
          <div className="text-xs text-gray-400">Local Streamable HTTP endpoint</div>
          <code className="block bg-port-bg border border-port-border rounded-lg px-3 py-2 text-xs text-port-accent break-all">
            /api/agent-context/mcp
          </code>
          <p className="text-xs text-gray-500">
            Runtime manifest: <code className="text-port-accent">/api/agent-context/manifest</code>
          </p>
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-white">OpenAPI spec</h3>
          <button
            type="button"
            onClick={loadSpec}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-port-border hover:bg-port-border/70 text-white text-xs rounded-lg"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Machine-readable description of every exposed API. Served at{' '}
          <code className="text-port-accent">/api/api-docs/openapi.json</code>.
        </p>
        {spec ? (
          <div className="text-xs text-gray-400">
            <span className="text-port-success">{Object.keys(spec.paths || {}).length}</span> path(s) documented
            {Object.keys(spec.paths || {}).length === 0 && ' — expose an API above to populate the spec.'}
          </div>
        ) : (
          <div className="text-xs text-gray-500">Spec unavailable.</div>
        )}
      </div>
    </div>
  );
}

export default ApiAccessTab;

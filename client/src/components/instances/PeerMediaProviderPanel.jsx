import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Gauge, Music2 } from 'lucide-react';
import { probePeer, updatePeer } from '../../services/api';
import Pill from '../ui/Pill';

const STATE_META = {
  ready: { label: 'ready', tone: 'success' },
  busy: { label: 'busy', tone: 'warning' },
  stale: { label: 'stale', tone: 'warning' },
  unauthorized: { label: 'auth required', tone: 'warning' },
  unsupported: { label: 'older peer', tone: 'note' },
  disabled: { label: 'provider off', tone: 'note' },
  unavailable: { label: 'unavailable', tone: 'warning' },
  unreachable: { label: 'unreachable', tone: 'warning' },
  invalid: { label: 'invalid status', tone: 'warning' },
};

const STATE_HELP = {
  busy: 'The peer is reachable, but its shared media lane is currently at capacity.',
  stale: 'The last capacity snapshot expired. New remote work is blocked until a fresh probe succeeds.',
  unauthorized: 'Store this peer’s instance-password credential above and make sure this instance is registered there.',
  unsupported: 'This peer does not expose the federated-media wire-v1 status endpoint yet.',
  disabled: 'Enable federated media sharing on the peer under Settings → Sharing.',
  unavailable: 'The peer has no currently ready allowlisted media runtime/model.',
  unreachable: 'The media status request failed. New remote work remains blocked.',
  invalid: 'The peer returned a response that did not match the versioned media-provider contract.',
};

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const keyOf = ({ engine, modelId }) => `${engine}\u0000${modelId}`;

function configOf(peer) {
  const raw = isRecord(peer?.mediaProvider) ? peer.mediaProvider : {};
  return {
    raw,
    enabled: raw.enabled === true,
    audioModels: Array.isArray(raw.audioModels) ? raw.audioModels : [],
  };
}

function modelRows(config, status) {
  const rows = new Map();
  for (const capability of status?.snapshot?.capabilities || []) {
    if (capability?.kind !== 'audio' || !capability.engine || !capability.modelId) continue;
    rows.set(keyOf(capability), capability);
  }
  for (const selected of config.audioModels) {
    if (!selected?.engine || !selected.modelId) continue;
    const key = keyOf(selected);
    if (!rows.has(key)) {
      rows.set(key, {
        kind: 'audio',
        engine: selected.engine,
        engineName: selected.engine,
        modelId: selected.modelId,
        modelName: selected.modelId,
        ready: false,
        unavailableReason: 'not-advertised',
      });
    }
  }
  return [...rows.values()];
}

export default function PeerMediaProviderPanel({ peer, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const config = configOf(peer);
  const status = peer.mediaProviderStatus || null;
  const rows = useMemo(() => modelRows(config, status), [config.raw, status]);
  const selectedKeys = new Set(config.audioModels
    .filter((model) => model?.engine && model.modelId)
    .map(keyOf));
  const stateMeta = !config.enabled
    ? { label: 'off', tone: 'note' }
    : peer.status !== 'online'
      ? { label: 'peer offline', tone: 'warning' }
      : STATE_META[status?.state] || { label: 'checking', tone: 'muted' };
  const queue = status?.snapshot?.queue;

  const saveConfig = async (next, { probe = false } = {}) => {
    setSaving(true);
    const updated = await updatePeer(peer.id, { mediaProvider: next }).catch(() => null);
    if (updated && probe) await probePeer(peer.id).catch(() => null);
    if (updated) onRefresh();
    setSaving(false);
  };

  const toggleEnabled = () => saveConfig(
    { ...config.raw, enabled: !config.enabled, audioModels: config.audioModels },
    { probe: !config.enabled },
  );

  const toggleModel = (model) => {
    const key = keyOf(model);
    const selected = selectedKeys.has(key);
    const audioModels = selected
      ? config.audioModels.filter((candidate) => keyOf(candidate) !== key)
      : [...config.audioModels, { engine: model.engine, modelId: model.modelId }];
    return saveConfig({ ...config.raw, enabled: config.enabled, audioModels });
  };

  const safePeerId = String(peer.id || 'peer').replace(/[^A-Za-z0-9_-]/g, '-');
  const enabledId = `${safePeerId}-remote-media-enabled`;

  return (
    <div className="mt-2 pt-2 border-t border-port-border/50">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1.5 w-full text-left group"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
        <Gauge size={12} className={config.enabled ? 'text-port-accent' : 'text-gray-500'} />
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium group-hover:text-gray-400 transition-colors">
          Remote media provider
        </span>
        <Pill tone={stateMeta.tone} size="xs" bordered={false} className="ml-auto">
          {stateMeta.label}
        </Pill>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 text-xs">
          <div className="flex items-start gap-2 rounded border border-port-border px-2 py-2">
            <input
              id={enabledId}
              type="checkbox"
              checked={config.enabled}
              disabled={saving || peer.enabled === false}
              onChange={toggleEnabled}
              className="mt-0.5 accent-port-accent"
            />
            <label htmlFor={enabledId} className="flex-1 text-gray-300 cursor-pointer">
              Use this peer for remote audio
              <span className="block text-[10px] text-gray-600 mt-0.5">
                Opt-in only. The server also requires an allowlisted model and fresh available capacity before routing.
              </span>
            </label>
          </div>

          {config.enabled && (
            <>
              {queue && (
                <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                  <Gauge size={11} />
                  <span>
                    {queue.running} running · {queue.queued} queued · {queue.totalActive}/{queue.maxQueuedJobs} shared slots active
                  </span>
                </div>
              )}

              {status?.state && status.state !== 'ready' && STATE_HELP[status.state] && (
                <p className="text-[10px] text-port-warning leading-snug">{STATE_HELP[status.state]}</p>
              )}

              <div className="space-y-1">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider">Allowed audio models</div>
                {rows.length === 0 ? (
                  <p className="text-[10px] text-gray-600">
                    No capabilities discovered yet. Verify peer authentication and probe again.
                  </p>
                ) : rows.map((model, index) => {
                  const key = keyOf(model);
                  const selected = selectedKeys.has(key);
                  const inputId = `${safePeerId}-remote-media-model-${index}`;
                  return (
                    <label
                      key={key}
                      htmlFor={inputId}
                      className="flex items-start gap-2 rounded border border-port-border/70 px-2 py-1.5 cursor-pointer"
                    >
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={selected}
                        disabled={saving}
                        onChange={() => toggleModel(model)}
                        className="sr-only"
                        aria-label={`Allow ${model.modelName}`}
                      />
                      <span className={`w-3 h-3 mt-0.5 rounded-sm border flex items-center justify-center shrink-0 ${
                        selected ? 'bg-port-accent border-port-accent' : 'border-gray-600'
                      }`}>
                        {selected && <Check size={8} className="text-white" />}
                      </span>
                      <Music2 size={12} className={model.ready ? 'text-port-success mt-0.5' : 'text-gray-500 mt-0.5'} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-gray-300 truncate">{model.modelName}</span>
                        <span className="block text-[10px] text-gray-600 truncate">
                          {model.engineName} · {model.ready ? 'ready' : model.unavailableReason || 'unavailable'}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

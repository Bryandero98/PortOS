/**
 * "Generation target" selector for any render form that can run a job on a
 * federated peer instead of on this machine (#4348).
 *
 * The peer list, the per-kind model allowlist intersection, and the readiness
 * verdict all come from `useFederatedMediaTarget` — this component only renders
 * them, so Music Studio, Image Gen and Video Gen cannot drift into three
 * different readings of the same peer.
 *
 * `localBlockedReason` is the HOST form's own veto (conditioning the federated
 * wire cannot carry, a mode that isn't text-to-media). It renders alongside the
 * target's readiness rather than replacing it: the two answer different
 * questions, and a form can be blocked by both at once.
 */

import { Server } from 'lucide-react';
import { federatedMediaModelKey, resolvePeerMediaReadiness } from '../../lib/federatedMediaReadiness.js';

const peerLabel = (peer) => peer.name || peer.address || 'Federated peer';

export default function RemoteMediaTargetPicker({
  target,
  kind,
  disabled = false,
  localBlockedReason = null,
  children = null,
}) {
  const {
    peers, peer, peerId, setPeerId, models, modelKey, setModelKey,
    isRemote, readiness, queueSegments, blockedReason,
  } = target;
  // Nothing is opted in as a provider — an empty "This instance" dropdown is a
  // control with one option and no way for the user to grow another.
  if (peers.length === 0) return null;

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Generation target</span>
        <select
          aria-label="Generation target"
          value={peerId}
          onChange={(e) => setPeerId(e.target.value)}
          disabled={disabled}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
        >
          <option value="">This instance</option>
          {peers.map((candidate) => {
            // Same reading as the caption and the submit button. Without the
            // suffix a switched-off or lapsed peer sits in the list looking
            // exactly like a ready one.
            const candidateReadiness = resolvePeerMediaReadiness(candidate);
            const suffix = candidateReadiness.usable ? '' : ` (${candidateReadiness.label})`;
            return (
              <option key={candidate.id} value={candidate.id}>
                {peerLabel(candidate)}{suffix}
              </option>
            );
          })}
        </select>
      </label>

      {isRemote && (
        <div className="space-y-2 rounded-lg border border-port-accent/30 bg-port-accent/5 p-2">
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <Server size={12} className="text-port-accent" />
            Rendered on {peerLabel(peer)} — {readiness?.label || 'checking'}
          </div>
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Remote {kind} model</span>
            <select
              aria-label={`Remote ${kind} model`}
              value={modelKey}
              onChange={(e) => setModelKey(e.target.value)}
              disabled={disabled || models.length === 0}
              className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
            >
              {models.length === 0 ? (
                <option value="">No allowlisted models discovered</option>
              ) : models.map((entry) => (
                <option key={federatedMediaModelKey(entry)} value={federatedMediaModelKey(entry)}>
                  {entry.modelName} — {entry.ready ? 'ready' : entry.unavailableReason || 'unavailable'}
                </option>
              ))}
            </select>
          </label>
          {/* A usable target carries no remedy text, so falling through to the
              generic sentence would print "not ready" beside a live button. */}
          <p className="text-[11px] text-gray-400" role="status">
            {blockedReason || queueSegments.join(' · ') || 'Peer is ready.'}
          </p>
          {localBlockedReason && (
            <p className="text-[11px] text-port-warning" role="status">{localBlockedReason}</p>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

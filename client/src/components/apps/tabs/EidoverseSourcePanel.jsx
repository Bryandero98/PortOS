import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  GitBranch,
  GitFork,
  RefreshCw,
  Server,
} from 'lucide-react';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import Modal from '../../ui/Modal';
import toast from '../../ui/Toast';

const statusTone = {
  current: 'bg-port-success/15 text-port-success',
  attention: 'bg-port-warning/15 text-port-warning',
  error: 'bg-port-error/15 text-port-error',
  unknown: 'bg-gray-500/15 text-gray-400',
};

function sourceStatus(source) {
  if (!source?.present) return { tone: 'error', label: 'Checkout missing' };
  if (!source.remoteFresh) return { tone: 'unknown', label: 'Remote check unavailable' };
  if (source.origin?.isFork && source.forkVsUpstream?.available === false) {
    return { tone: 'unknown', label: 'Upstream check unavailable' };
  }
  if (source.forkVsUpstream?.state === 'diverged') {
    return { tone: 'error', label: 'Fork diverged' };
  }
  const forkBehind = source.forkVsUpstream?.behind || 0;
  const localBehind = source.localVsOrigin?.behind || 0;
  if (forkBehind > 0 && localBehind > 0) {
    return { tone: 'attention', label: 'Fork and checkout behind' };
  }
  if (forkBehind > 0) {
    return { tone: 'attention', label: `Fork ${forkBehind} behind` };
  }
  if (localBehind > 0) {
    return { tone: 'attention', label: `Checkout ${localBehind} behind` };
  }
  if (source.localVsOrigin?.state === 'diverged') {
    return { tone: 'error', label: 'Checkout diverged' };
  }
  if ((source.localVsOrigin?.ahead || 0) > 0) {
    return { tone: 'attention', label: `Checkout ${source.localVsOrigin.ahead} ahead` };
  }
  if (source.origin?.hasOrigin && !source.origin.isUpstream) {
    return { tone: 'attention', label: 'Custom origin' };
  }
  return { tone: 'current', label: 'Current' };
}

const countText = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function RepositoryCard({ source }) {
  const status = sourceStatus(source);
  const isWorlds = source.id === 'worlds';
  const originName = source.origin?.fullName || 'configured origin';
  const upstreamName = source.upstream?.fullName || 'canonical upstream';
  const local = source.localVsOrigin;
  const fork = source.forkVsUpstream;

  return (
    <section className="rounded-xl border border-port-border bg-port-bg/50 p-4" data-testid={`eidoverse-source-${source.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            {isWorlds ? <GitBranch size={17} className="text-port-accent" /> : <Server size={17} className="text-cyan-400" />}
            <h4 className="font-medium text-white">{source.label}</h4>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {isWorlds ? 'World and application checkout' : 'Sidecar runtime · independent checkout · not a submodule'}
          </p>
        </div>
        <span className={`rounded-full px-2 py-1 text-xs font-medium ${statusTone[status.tone]}`}>
          {status.label}
        </span>
      </div>

      {source.present ? (
        <div className="mt-4 space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-gray-400">
            <code className="rounded bg-port-card px-2 py-1 text-xs text-gray-200">
              {source.branch || 'detached'} @ {source.shortHead || 'unknown'}
            </code>
            <span className={source.clean === false ? 'text-port-warning' : 'text-gray-500'}>
              {source.clean === true ? 'clean checkout' : source.clean === false ? 'local changes' : 'worktree unknown'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-400" aria-label={`${source.label} repository topology`}>
            <span className="rounded bg-port-card px-2 py-1">local checkout</span>
            <span aria-hidden="true">→</span>
            <span className="rounded bg-port-card px-2 py-1">
              {originName}{source.origin?.isFork ? ' (fork)' : ''}
            </span>
            {source.origin?.isFork && (
              <>
                <span aria-hidden="true">→</span>
                <span className="rounded bg-port-card px-2 py-1">{upstreamName} (upstream)</span>
              </>
            )}
          </div>

          {local && (local.ahead > 0 || local.behind > 0) && (
            <p className="text-xs text-gray-400">
              Local checkout is {countText(local.behind, 'commit')} behind and {countText(local.ahead, 'commit')} ahead of {originName}.
            </p>
          )}
          {fork?.available && (fork.ahead > 0 || fork.behind > 0) && (
            <p className={`text-xs ${fork.state === 'diverged' ? 'text-port-error' : 'text-gray-400'}`}>
              Fork is {countText(fork.behind, 'commit')} behind and {countText(fork.ahead, 'commit')} ahead of {upstreamName}.
            </p>
          )}
          {source.remoteError && (
            <p className="flex items-start gap-1.5 text-xs text-port-warning">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {source.remoteError}; the displayed remote revision may be stale.
            </p>
          )}
          {fork?.error && (
            <p className="flex items-start gap-1.5 text-xs text-port-warning">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {fork.error}; fork freshness is unknown.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-4 text-sm text-port-error">{source.remoteError || 'Checkout not found'}</p>
      )}
    </section>
  );
}

export default function EidoverseSourcePanel({ appId, onUpdated }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingFork, setSyncingFork] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState(null);
  const [updateIntent, setUpdateIntent] = useState(null);

  const load = useCallback(async ({ initial = false } = {}) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    const result = await api.getAppRepositorySources(appId, { silent: true }).catch((reason) => {
      setError(reason.message || 'Could not inspect the Eidoverse repositories');
      return null;
    });
    if (result) setStatus(result);
    setLoading(false);
    setRefreshing(false);
    return result;
  }, [appId]);

  useEffect(() => {
    load({ initial: true });
  }, [load]);

  const sources = status?.sources || [];
  const worlds = sources.find((source) => source.id === 'worlds') || null;
  const video = sources.find((source) => source.id === 'video') || null;
  const forkDiverged = worlds?.forkVsUpstream?.state === 'diverged';
  const forkNeedsSync = worlds?.origin?.isFork
    && (worlds.forkVsUpstream?.behind || 0) > 0
    && !forkDiverged;
  const remoteUnknown = sources.some((source) => (
    !source.remoteFresh
    || (source.origin?.isFork && source.forkVsUpstream?.available === false)
  ));
  const canUpdate = sources.every((source) => source.present) && status?.updatePullsBoth;
  const shouldOfferUpdate = status?.updateAvailable || remoteUnknown;
  const primaryLabel = forkNeedsSync
    ? 'Sync fork & update both'
    : worlds?.origin?.isFork ? 'Update both from fork' : 'Update both';

  const updateSummary = useMemo(() => {
    if (!status) return '';
    if (status.updateAvailable) return 'One managed update will bring the source stack forward.';
    if (remoteUnknown) return 'Remote freshness is unknown; a managed update can retry both repositories.';
    return 'Both checkouts are current.';
  }, [remoteUnknown, status]);

  const handleSyncOnly = async () => {
    setSyncingFork(true);
    const result = await api.syncAppRepositoryFork(appId, { silent: true }).catch((reason) => {
      toast.error(reason.message || 'Could not sync the Eidoverse Worlds fork');
      return null;
    });
    if (result) {
      toast.success(result.alreadyUpToDate ? 'Worlds fork is already current' : 'Worlds fork synced from upstream');
      await load();
    }
    setSyncingFork(false);
  };

  const handleManagedUpdate = async () => {
    const intent = updateIntent;
    setUpdateIntent(null);
    setUpdating(true);

    let forkReady = true;
    if (intent?.syncFork) {
      forkReady = Boolean(await api.syncAppRepositoryFork(appId, { silent: true }).catch((reason) => {
        toast.error(reason.message || 'Could not sync the Eidoverse Worlds fork');
        return null;
      }));
    }

    const result = forkReady
      ? await api.pullAndUpdateApp(appId, { silent: true }).catch((reason) => {
        toast.error(reason.message || 'Could not update Eidoverse');
        return null;
      })
      : null;
    if (result?.success) {
      toast.success('Eidoverse Worlds and Video updated; Eidoverse restarted');
      await load();
      onUpdated?.();
    }
    setUpdating(false);
  };

  return (
    <div className="rounded-xl border border-port-accent/30 bg-port-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitFork size={19} className="text-port-accent" />
            <h3 className="font-semibold text-white">Eidoverse source stack</h3>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-gray-400">
            Worlds and Video are separate Git checkouts. Video is the runtime sidecar, not a submodule; PortOS updates both together.
          </p>
        </div>
        <button
          onClick={() => load()}
          disabled={loading || refreshing || syncingFork || updating}
          className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-2 text-sm text-gray-300 hover:border-port-accent hover:text-white disabled:opacity-50"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Checking...' : 'Check sources'}
        </button>
      </div>

      {loading && !status ? (
        <div className="py-8 text-center"><BrailleSpinner text="Checking Eidoverse sources" /></div>
      ) : error && !status ? (
        <div className="mt-4 rounded-lg border border-port-error/30 bg-port-error/10 p-3 text-sm text-port-error" role="alert">
          {error}
        </div>
      ) : status ? (
        <>
          {error && (
            <div className="mt-4 rounded-lg border border-port-warning/30 bg-port-warning/10 p-3 text-sm text-port-warning" role="alert">
              {error}; showing the last source check.
            </div>
          )}
          <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
            {worlds && <RepositoryCard source={worlds} />}
            {video && <RepositoryCard source={video} />}
          </div>

          {!status.updatePullsBoth && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-port-error/30 bg-port-error/10 p-3 text-sm text-port-error" role="alert">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              This older app registration does not yet include Video in managed updates. Update PortOS and run its pending migrations before updating Eidoverse.
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-port-border pt-4">
            <div className="flex items-center gap-2 text-sm text-gray-400">
              {!status.updateAvailable && !remoteUnknown && <CheckCircle2 size={16} className="text-port-success" />}
              {updateSummary}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {worlds?.origin?.isFork && (
                <button
                  onClick={handleSyncOnly}
                  disabled={syncingFork || updating || forkDiverged}
                  title={forkDiverged
                    ? 'Reconcile the fork commits on GitHub before syncing'
                    : 'Fast-forward the GitHub fork only; does not touch the checkout or restart Eidoverse'}
                  className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-port-border px-3 py-2 text-sm text-gray-300 hover:border-port-accent hover:text-white disabled:opacity-50"
                >
                  <GitFork size={15} className={syncingFork ? 'animate-pulse' : ''} />
                  {forkDiverged ? 'Fork needs reconciliation' : syncingFork ? 'Syncing fork...' : 'Sync fork only'}
                </button>
              )}
              {shouldOfferUpdate && (
                <button
                  onClick={() => setUpdateIntent({ syncFork: forkNeedsSync })}
                  disabled={!canUpdate || syncingFork || updating}
                  className="flex min-h-[40px] items-center gap-1.5 rounded-lg bg-port-accent px-4 py-2 text-sm text-white hover:bg-port-accent/80 disabled:opacity-50"
                >
                  <Download size={16} className={updating ? 'animate-bounce' : ''} />
                  {updating ? 'Updating both...' : primaryLabel}
                </button>
              )}
            </div>
          </div>
        </>
      ) : null}

      <Modal
        open={Boolean(updateIntent)}
        onClose={() => setUpdateIntent(null)}
        size="md"
        align="none"
        backdropClassName="bg-black/50"
        panelClassName="bg-port-card border border-port-border rounded-xl overflow-hidden"
        ariaLabelledBy="eidoverse-source-update-title"
      >
        <div className="flex items-center justify-between border-b border-port-border p-4">
          <h3 id="eidoverse-source-update-title" className="flex items-center gap-2 font-medium text-white">
            <Download size={18} className="text-port-accent" />
            Update the Eidoverse source stack?
          </h3>
          <button
            onClick={() => setUpdateIntent(null)}
            aria-label="Close"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center text-gray-400 hover:text-white"
          >×</button>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-sm text-gray-300">This managed update will:</p>
          <ul className="ml-4 list-disc space-y-1.5 text-sm text-gray-400">
            {updateIntent?.syncFork && <li>Fast-forward the Worlds fork from canonical upstream without forcing</li>}
            <li>Pull the Worlds checkout from its configured origin</li>
            <li>Pull the independent Eidoverse Video sidecar checkout</li>
            <li>Install frozen Bun dependencies</li>
            <li>Restart Eidoverse Worlds only; PortOS and its CoS agents keep running</li>
          </ul>
        </div>
        <div className="flex justify-end gap-3 border-t border-port-border p-4">
          <button onClick={() => setUpdateIntent(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            onClick={handleManagedUpdate}
            className="flex items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm text-white hover:bg-port-accent/80"
          >
            <Download size={16} />
            {updateIntent?.syncFork ? 'Sync and update both' : 'Update both'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

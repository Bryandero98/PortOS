import { CheckCircle2, CircleAlert, CircleHelp, RefreshCw } from 'lucide-react';
import { formatDateTime } from '../../utils/formatters.js';

const readinessLabel = (readiness) => {
  if (readiness === 'ready') return 'Ready';
  if (readiness === 'degraded') return 'Degraded';
  if (readiness === 'blocked') return 'Blocked';
  return 'Unknown';
};

const readinessClass = (readiness) => {
  if (readiness === 'ready') return 'text-port-success';
  if (readiness === 'degraded') return 'text-port-warning';
  if (readiness === 'blocked') return 'text-port-error';
  return 'text-port-text-muted';
};

const ReadinessIcon = ({ readiness }) => {
  if (readiness === 'ready') return <CheckCircle2 size={15} aria-hidden="true" />;
  if (readiness === 'unknown') return <CircleHelp size={15} aria-hidden="true" />;
  return <CircleAlert size={15} aria-hidden="true" />;
};

const checkLabel = (preflight, check) => {
  const hasWorkspace = Array.isArray(preflight.workspaces) && preflight.workspaces.length > 0;
  if (check === 'dependencies') return hasWorkspace && !preflight.workspaces.some((workspace) => workspace.dependencies?.status !== 'installed') ? 'Dependencies available' : 'Dependencies need attention';
  if (check === 'engines') return hasWorkspace && !preflight.workspaces.some((workspace) => ['incompatible', 'unknown'].includes(workspace.engines?.node?.status) || ['incompatible', 'unknown'].includes(workspace.engines?.packageManager?.status)) ? 'Engines compatible' : 'Engine compatibility needs attention';
  if (check === 'submodules') return preflight.submodules?.status === 'initialized' || preflight.submodules?.status === 'not-configured' ? 'Submodules ready' : 'Submodules need attention';
  if (check === 'forge') return preflight.forge?.status === 'ready' ? 'Forge access available' : 'Forge access needs attention';
  if (check === 'reviewers') return preflight.reviewers?.required?.status === 'ready' ? 'Required reviewers available' : 'Reviewer availability needs attention';
  return null;
};

export default function PersistentMindVisibilityPanel({ visibility, error, loading, onRefresh }) {
  const workspaces = Array.isArray(visibility?.workspaces) ? visibility.workspaces : [];
  const readiness = visibility?.readiness || 'unknown';
  const warnings = workspaces.flatMap((workspace) => workspace.preflight?.warnings || []);
  const uniqueWarnings = warnings.filter((warning, index, values) => values.findIndex((candidate) => candidate.code === warning.code) === index);

  return (
    <section aria-label="Persistent mind environment visibility" className="rounded border border-port-border bg-port-card p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-port-accent">Environment visibility</h3>
          <p className="mt-1 text-xs text-port-text-muted">Read-only workspace facts used before the mind queues delegated work.</p>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center justify-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs font-medium text-port-text hover:bg-port-border/20 disabled:cursor-not-allowed disabled:opacity-60">
          <RefreshCw size={13} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className={`inline-flex items-center gap-1.5 font-semibold ${readinessClass(readiness)}`}>
          <ReadinessIcon readiness={readiness} />
          {readinessLabel(readiness)}
        </span>
        <span className="text-port-text-muted">
          Captured {visibility?.capturedAt ? formatDateTime(visibility.capturedAt) : '—'} · {visibility?.freshness?.state || 'unknown'} snapshot
        </span>
        {visibility?.truncated && <span className="text-port-warning">Some checks were bounded before completion.</span>}
      </div>

      {workspaces.length > 0 ? (
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {workspaces.map((workspace) => {
            const workspaceReadiness = workspace.readiness || 'unknown';
            const preflight = workspace.preflight || {};
            return (
              <article key={workspace.appId || workspace.appName} className="rounded border border-port-border/80 p-3" aria-label={`${workspace.appName || 'Workspace'} preflight`}>
                <div className="flex items-center justify-between gap-2">
                  <h4 className="min-w-0 truncate text-sm font-medium text-port-text">{workspace.appName || 'Workspace'}</h4>
                  <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${readinessClass(workspaceReadiness)}`}>
                    <ReadinessIcon readiness={workspaceReadiness} />
                    {readinessLabel(workspaceReadiness)}
                  </span>
                </div>
                <div className="mt-2 grid gap-1 text-xs text-port-text-muted sm:grid-cols-2">
                  {['dependencies', 'engines', 'submodules', 'forge', 'reviewers'].map((check) => (
                    <span key={check}>{checkLabel(preflight, check)}</span>
                  ))}
                </div>
                {(workspaceReadiness === 'blocked' || workspaceReadiness === 'unknown') && (
                  <p className="mt-2 text-xs text-port-warning">{workspaceReadiness === 'blocked' ? 'A required workspace check must be repaired before this task can run.' : 'A workspace probe could not complete. Refresh or repair the unavailable check before requiring it.'}</p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-xs text-port-text-muted">No configured workspaces were available to inspect.</p>
      )}

      {(uniqueWarnings.length > 0 || error) && (
        <div className="mt-3 border-t border-port-border pt-3 text-xs text-port-warning">
          {error && <p>Visibility refresh delayed: {error}. The last successful snapshot remains in use.</p>}
          {uniqueWarnings.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {uniqueWarnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

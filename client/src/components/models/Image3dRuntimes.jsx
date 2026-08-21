import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2 } from 'lucide-react';
import { getImageTo3dTargets } from '../../services/api';
import { useHfTokenStatus } from '../../hooks/useHfTokenStatus';
import { unavailableReasonLabel } from '../../lib/imageTo3dReasons';
import RuntimeInstallModal from '../install/RuntimeInstallModal';
import Image3dHfAccessNotice from '../media/Image3dHfAccessNotice';

/**
 * Models → 3D: install, repair, and inspect the image-to-3D runtimes.
 *
 * These are installed weights and on-device runtimes (TRELLIS.2, Pixal3D), so
 * they belong with the rest of the model inventory rather than inside the
 * generate flow that consumes them (#4728). `/3d` keeps the generate flow — an
 * image in, a mesh out, plus the library of past renders — and links here for
 * the install lifecycle.
 */

const LANE_LABEL = {
  'local-mps': 'Runs on-device (Apple Silicon)',
  'local-cuda': 'Runs on-device (CUDA)',
  'hosted-api': 'Hosted API',
};

function StatusBadge({ target }) {
  if (!target.available) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-port-warning">
        <AlertTriangle className="w-3.5 h-3.5" />
        {unavailableReasonLabel(target.unavailableReason)}
      </span>
    );
  }
  if (target.installed) {
    // An installed-but-degraded target still renders — TRELLIS.2 with no Metal bake
    // produces correct geometry with a scrambled surface; Pixal3D with no NATTEN
    // falls back to DINO projection features — so "Ready" alone would be a lie. The
    // server normalizes every such case into `degraded` (see the adapter contract),
    // and a probe that could NOT run reports nothing here rather than crying wolf
    // about an install that is probably fine.
    if (target.degraded) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-port-warning">
          <AlertTriangle className="w-3.5 h-3.5" /> Ready · {target.degraded.label}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-port-success">
        <CheckCircle2 className="w-3.5 h-3.5" /> Ready
      </span>
    );
  }
  return null;
}

function TargetCard({ target, onInstall }) {
  // Install only applies to targets with a local install concept (installed is a
  // boolean); hosted targets report installed:null and are Ready when available.
  const canInstall = target.available && target.installed === false;
  const degraded = target.degraded;
  // Repair install re-runs setup — but only offer it when the server says it can
  // actually fix this. On a Command-Line-Tools-only host `repairable` is false and the
  // remedy is installing Xcode, so a Repair button would just fail the same way and
  // read as broken.
  const canRepair = !!degraded && degraded.repairable !== false;

  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">{target.label}</h2>
            {target.executionLane && (
              <span className="rounded bg-port-bg px-1.5 py-0.5 text-[11px] text-gray-400">
                {LANE_LABEL[target.executionLane] || target.executionLane}
              </span>
            )}
          </div>
          {target.description && (
            <p className="mt-1 text-xs text-gray-400">{target.description}</p>
          )}
          {(target.upstream || target.port) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
              {target.upstream && (
                <a href={target.upstream} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-port-accent">
                  <ExternalLink className="w-3 h-3" /> Upstream
                </a>
              )}
              {target.port && (
                <a href={target.port} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-port-accent">
                  <ExternalLink className="w-3 h-3" /> Apple Silicon port
                </a>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge target={target} />
          {(canInstall || canRepair) && (
            <button
              onClick={() => onInstall(target)}
              className="inline-flex items-center gap-1.5 rounded-md bg-port-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
            >
              <Download className="w-3.5 h-3.5" /> {canInstall ? 'Install' : 'Repair install'}
            </button>
          )}
        </div>
      </div>
      {degraded?.help && (
        <p className="mt-3 rounded border border-port-warning/40 bg-port-warning/10 p-2 text-[11px] leading-relaxed text-port-warning">
          {degraded.help}
        </p>
      )}
    </div>
  );
}

export default function Image3dRuntimes() {
  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The target whose install modal is open (only local-install targets); null = closed.
  const [installTarget, setInstallTarget] = useState(null);
  const { present: hfTokenPresent, source: hfTokenSource, refresh: refreshHfToken } = useHfTokenStatus();

  const load = useCallback(() => {
    setLoading(true);
    getImageTo3dTargets()
      .then((data) => { setTargets(data?.targets || []); setError(null); })
      .catch((err) => setError(err?.message || 'Failed to load 3D targets'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Every gated repo across the runnable targets, deduped by id — the token is
  // central, so listing one target's repos twice would just be noise. Unavailable
  // targets are excluded: their terms are irrelevant on a host that can't run them.
  const gatedHfModels = useMemo(() => {
    const seen = new Map();
    for (const target of targets) {
      if (!target.available) continue;
      for (const model of target.gatedRepos || []) {
        const key = model?.url || model?.label;
        if (key && !seen.has(key)) seen.set(key, model);
      }
    }
    return [...seen.values()];
  }, [targets]);

  const gatedRepoCount = installTarget?.gatedRepos?.length || 0;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <p className="text-sm text-gray-400">
        On-device image-to-3D runtimes. Install one here, then render meshes from the 3D page under Create.
      </p>

      {gatedHfModels.length > 0 && (
        <Image3dHfAccessNotice
          models={gatedHfModels}
          tokenPresent={hfTokenPresent}
          tokenSource={hfTokenSource}
          onSaved={refreshHfToken}
        />
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading models…
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center justify-between rounded-lg border border-port-error/40 bg-port-error/10 p-4 text-sm text-port-error">
          <span>{error}</span>
          <button onClick={load} className="rounded-md border border-port-error/50 px-3 py-1 text-xs hover:bg-port-error/20">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-3">
          {targets.length === 0 && (
            <p className="text-sm text-gray-500">No image-to-3D models are registered.</p>
          )}
          {targets.map((target) => (
            <TargetCard key={target.id} target={target} onInstall={setInstallTarget} />
          ))}
        </div>
      )}

      {/* TRELLIS.2 (and any future local-install target) streams its clone +
          setup.sh install through the shared runtime-install modal. */}
      <RuntimeInstallModal
        open={!!installTarget}
        runtime={installTarget?.id}
        label={installTarget?.label}
        installUrlBase={installTarget ? `/api/image-to-3d/targets/${installTarget.id}/install` : undefined}
        // Repairing an already-installed target must re-run its setup rather than
        // short-circuit on "already installed" — that re-run is what rebuilds whatever
        // was missing (TRELLIS.2's Metal backends, Pixal3D's NATTEN kernels) now that
        // its build deps are present.
        params={installTarget?.degraded ? { repair: '1' } : undefined}
        // Copy comes from the target descriptor, never hard-coded here: this modal is
        // shared by every target, so TRELLIS.2-specific prose would misdescribe the
        // others. A degraded target explains its own remedy via `degraded.help`.
        // `undefined` rather than '' when a target has nothing to say, so
        // RuntimeInstallModal's own default description applies instead of a blank panel.
        description={installTarget?.degraded
          // The degraded help text owns the whole message (both targets' already end by
          // saying downloaded models are kept) — appending to it would repeat that.
          ? installTarget.degraded.help
          : [
            installTarget?.installNotes,
            gatedRepoCount
              ? `It also pulls ${gatedRepoCount} gated Hugging Face ${gatedRepoCount === 1 ? 'model' : 'models'} on first render — accept their terms and add a Hugging Face token above.`
              : null,
          ].filter(Boolean).join(' ') || undefined}
        onClose={() => setInstallTarget(null)}
        onComplete={() => { setInstallTarget(null); load(); }}
      />
    </div>
  );
}

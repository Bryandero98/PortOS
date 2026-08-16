import { memo } from 'react';
import { Link } from 'react-router';
import { Cpu, ExternalLink, X } from 'lucide-react';
import * as api from '../../services/api';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';

const elapsed = (startedAt, now = Date.now()) => {
  if (!startedAt) return 'queued';
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
const eta = (etaMs) => (Number.isFinite(etaMs) && etaMs >= 0 ? `~${Math.ceil(etaMs / 60000)}m` : null);

function JobRow({ job, onCancel }) {
  const tag = job.params?.musicStudio;
  const label = tag?.title || job.params?.characterName || `${job.kind} render`;
  const target = tag?.trackId ? `/music/tracks/${encodeURIComponent(tag.trackId)}` : null;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-port-border bg-port-bg/60 px-2 py-1.5 text-xs">
      <span className={`h-2 w-2 rounded-full ${job.status === 'running' ? 'bg-port-accent animate-pulse' : 'bg-port-warning'}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-gray-200">{label}</span>
      <span className="shrink-0 font-mono text-gray-500">{job.status === 'queued' ? `#${job.position || '—'}` : elapsed(job.startedAt)}{eta(job.etaMs) ? ` · ${eta(job.etaMs)}` : ''}</span>
      {target ? <Link to={target} title="Open track" className="text-gray-500 hover:text-port-accent"><ExternalLink size={13} /></Link> : null}
      <button type="button" onClick={() => onCancel(job.id)} title="Cancel render" aria-label="Cancel render" className="text-gray-500 hover:text-port-warning"><X size={13} /></button>
    </div>
  );
}

function ActiveProcessingWidget() {
  const { data, loading } = useAutoRefetch(() => api.getActiveProcessing({ silent: true }), 3000, {
    compare: (a, b) => a?.updatedAt === b?.updatedAt,
  });
  const cancel = (id) => api.cancelMediaJob(id, { silent: true }).catch(() => undefined);
  const jobs = data?.jobs || [];
  const gpu = data?.gpu;
  const idle = !jobs.length && !(data?.extras?.imageTo3d || []).length && !(data?.agents?.active || 0);
  return (
    <div className="h-full rounded-xl border border-port-border bg-port-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Cpu size={15} className="text-port-accent" /> Active Processing</h3>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">live</span>
      </div>
      {loading && !data ? <p className="text-xs text-gray-500">Checking render lanes…</p> : null}
      {idle ? <div className="rounded-lg border border-port-border bg-port-bg px-3 py-3 text-xs text-gray-400">Idle · GPU {gpu?.status === 'available' ? 'ready' : gpu?.status || 'unknown'}</div> : null}
      <div className="space-y-1.5">{jobs.map((job) => <JobRow key={job.id} job={job} onCancel={cancel} />)}</div>
      {(data?.extras?.imageTo3d || []).map((item) => <div key={`3d-${item.id}`} className="mt-1.5 text-xs text-gray-400">Image-to-3D · {item.name}</div>)}
      {data?.agents?.active ? <div className="mt-2 text-xs text-gray-400">CoS agents · {data.agents.active} active{data.agents.queued ? ` · ${data.agents.queued} queued` : ''}</div> : null}
      {gpu?.status === 'available' && gpu.gpus?.length ? <div className="mt-3 text-[11px] text-gray-500">GPU {gpu.gpus[0].utilizationPercent == null ? 'utilization unknown' : `${Math.round(gpu.gpus[0].utilizationPercent)}% utilized`}</div> : null}
    </div>
  );
}

export default memo(ActiveProcessingWidget);

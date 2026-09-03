/**
 * "Queue agent to investigate" action for an installer failure (#5981).
 *
 * An install error used to be a dead end — Close was the only affordance — even
 * though PortOS already owns an autonomous-agent queue. This button hands the
 * failure straight to that queue: it builds a reproducible task from the
 * installer name, the failing stage, the error and the streamed log tail, and
 * posts it via `addCosTask` with no `app`, which targets PortOS itself (the
 * installer code lives in this repo).
 *
 * Rendered by `InstallErrorFooter` (both install modals) and directly by
 * `LocalSetupPanel`, which draws its own error region.
 */

import { useState } from 'react';
import { Bot, Check } from 'lucide-react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { buildInstallFailureTask } from '../../lib/installFailureTask';
import { addCosTask } from '../../services/api';
import toast from '../ui/Toast';

export default function QueueInstallInvestigationButton({
  label,
  stage,
  error,
  logs,
  surface,
  className = '',
}) {
  const [queued, setQueued] = useState(false);
  // `useAsyncAction` owns the failure toast, so the request itself is silent —
  // otherwise the user gets two toasts for one failed queue.
  const [queueTask, queueing] = useAsyncAction(async () => {
    const task = buildInstallFailureTask({ label, stage, error, logs, surface });
    await addCosTask({ ...task, useWorktree: true, openPR: true }, { silent: true });
    setQueued(true);
    toast.success('Queued an agent to investigate this failure');
  }, { errorMessage: 'Failed to queue the investigation task' });

  return (
    <button
      type="button"
      onClick={queueTask}
      disabled={queueing || queued}
      title={queued
        ? 'An agent task for this failure is already queued'
        : 'Queue a PortOS agent task to investigate this install failure'}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 disabled:hover:bg-port-accent ${className}`}
    >
      {queued ? <Check size={14} /> : <Bot size={14} />}
      {queued ? 'Agent queued' : queueing ? 'Queueing…' : 'Queue agent to investigate'}
    </button>
  );
}

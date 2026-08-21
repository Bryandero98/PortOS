/**
 * "Measure every model" — the overnight sweep control.
 *
 * Measuring one model takes minutes, so measuring all of them is something you
 * start at the end of the day. Two consequences shape this component:
 *
 *   1. **The run does not belong to this tab.** The server owns the queue; this
 *      polls its status and listens for socket frames. Closing the browser, or
 *      reloading, must not stop or lose an overnight run — so there is no abort
 *      controller here and no in-flight request to hold open.
 *   2. **Consent names real numbers.** The AI Provider Usage Policy (root
 *      CLAUDE.md) requires that a batch of provider calls be preceded by a gate
 *      that says exactly what will run. The counts come from the server's own
 *      target selector, not from a client-side estimate, so the number shown is
 *      the number that executes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PlayCircle, Square, AlertTriangle, CheckCircle2 } from 'lucide-react';
import Modal from '../ui/Modal';
import ProgressBar from '../ui/ProgressBar';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import useMounted from '../../hooks/useMounted';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import { formatContextTokens, throughputLabel, timeAgo } from '../../utils/formatters';
import {
  getLocalLlmAssessmentSweep, startLocalLlmAssessmentSweep, cancelLocalLlmAssessmentSweep,
} from '../../services/api';

const SCOPES = [
  { id: 'unmeasured', label: 'Only models never measured', blurb: 'Leaves existing readings alone.' },
  { id: 'stale', label: 'Only stale readings', blurb: 'Re-runs measurements taken on a different machine state, reusing each one\'s tuning.' },
  { id: 'all', label: 'Everything installed', blurb: 'Every unmeasured model, plus a fresh reading for every configuration already recorded.' },
];

// How often to re-read the queue while it runs. Socket frames drive the live
// message; this is the reload-safe backstop that also catches the transition to
// finished when the last frame is missed.
const POLL_MS = 5000;

const isRunning = (status) => status?.status === 'running';

function SweepConsentModal({ scope, onScopeChange, counts, contextTokens, onCancel, onConfirm, starting }) {
  const count = counts?.[scope] ?? 0;
  const generations = count * Math.max(1, contextTokens.length);
  return (
    <Modal open onClose={onCancel} size="sm" ariaLabel="Measure every local model">
      <div className="bg-port-card border border-port-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <PlayCircle size={18} className="text-port-accent" />
          <h3 className="text-white font-medium">Measure every model?</h3>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs text-gray-400 mb-1">What to measure</legend>
          {SCOPES.map((option) => {
            const optionCount = counts?.[option.id] ?? 0;
            const fieldId = `sweep-scope-${option.id}`;
            return (
              <div key={option.id} className="flex items-start gap-2">
                <input
                  id={fieldId}
                  type="radio"
                  name="sweep-scope"
                  checked={scope === option.id}
                  disabled={starting || optionCount === 0}
                  onChange={() => onScopeChange(option.id)}
                  className="mt-1 accent-port-accent"
                />
                <label htmlFor={fieldId} className={`min-w-0 ${optionCount === 0 ? 'opacity-50' : ''}`}>
                  <span className="text-xs text-gray-200">{option.label}</span>
                  <span className="text-xs text-gray-500 ml-1.5">
                    ({optionCount} model{optionCount === 1 ? '' : 's'})
                  </span>
                  <p className="text-[10px] text-gray-500 leading-snug">{option.blurb}</p>
                </label>
              </div>
            );
          })}
        </fieldset>

        <p className="text-sm text-gray-400">
          PortOS will run <span className="text-gray-200">{count}</span> measurement{count === 1 ? '' : 's'} —{' '}
          <span className="text-gray-200">{generations}</span> short generation{generations === 1 ? '' : 's'} in
          total, one at each of {contextTokens.map(formatContextTokens).join(', ')} tokens of context per model.
        </p>
        <p className="text-xs text-gray-500">
          They run one at a time (two models at once would measure the contention, not the models), which makes
          this a job for overnight — expect several minutes per model. It keeps running with this tab closed,
          and you can stop it at any point; everything measured up to then is kept.
        </p>

        <div className="flex gap-3 pt-1">
          <button
            onClick={onCancel}
            disabled={starting}
            className="flex-1 px-4 py-2 bg-port-card border border-port-border hover:border-port-accent text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={starting || count === 0}
            className="flex-1 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-port-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {starting ? <><BrailleSpinner /> Starting…</> : <>Start sweep</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One finished measurement from the queue. */
function SweepResultRow({ result }) {
  const failed = Boolean(result.error) || result.verdict === 'does-not-fit' || result.verdict === 'incompatible';
  return (
    <div className="flex items-center gap-2 text-[11px] flex-wrap">
      {failed
        ? <AlertTriangle size={11} className="text-port-warning shrink-0" />
        : <CheckCircle2 size={11} className="text-emerald-400 shrink-0" />}
      <span className="text-gray-300 font-mono break-all min-w-0">{result.modelId}</span>
      {/* The tokens/s figure is the headline of a sweep, so it leads where the
          runtime reported one; chars/s is the fallback, never both. */}
      <span className="text-gray-500">
        {result.error || [result.verdict, throughputLabel(result)].filter(Boolean).join(' — ')}
      </span>
    </div>
  );
}

/**
 * @param {object} props
 * @param {Record<string, number>} props.counts per-scope target counts from the report
 * @param {number[]} props.contextTokens context sizes each measurement samples
 * @param {() => void} props.onSweepFinished refresh the report once the queue ends
 * @param {(running: boolean) => void} [props.onRunningChange] lets the parent
 *   disable its own per-model Measure buttons while the queue holds the provider
 * @param {boolean} props.disabled a single-model run is already occupying the provider
 */
export default function AssessmentSweepPanel({ counts, contextTokens = [], onSweepFinished, onRunningChange, disabled }) {
  const [status, setStatus] = useState(null);
  const [showConsent, setShowConsent] = useState(false);
  const [scope, setScope] = useState('unmeasured');
  // The live socket message for the model in flight. Reset whenever the model
  // changes so a stale line never sits under a different model's name.
  const [message, setMessage] = useState('');
  const mountedRef = useMounted();

  const refresh = useCallback(async () => {
    const next = await getLocalLlmAssessmentSweep({ silent: true }).catch(() => null);
    if (!next || !mountedRef.current) return null;
    setStatus(next);
    return next;
  }, [mountedRef]);

  // A sweep that started in another tab (or before a reload) has to show up here
  // — the queue is server state, not this component's.
  useEffect(() => { refresh(); }, [refresh]);

  const running = isRunning(status);
  // `onSweepFinished` is a fresh closure on every parent render, so keeping it in
  // a ref stops the poll callback from re-registering on each one.
  const finishedRef = useRef(onSweepFinished);
  finishedRef.current = onSweepFinished;

  // `onSweepFinished` re-reads the whole assessment report, which probes every
  // runtime — expensive enough that firing it twice for one finish (a poll tick
  // racing the terminal socket frame) is worth latching out.
  const finishNotifiedRef = useRef(false);
  const notifyFinished = useCallback(() => {
    if (finishNotifiedRef.current) return;
    finishNotifiedRef.current = true;
    finishedRef.current?.();
  }, []);

  // A single-model run started mid-sweep would contend with the model the queue
  // is measuring, and BOTH readings would describe that contention. Tell the
  // parent so its per-model buttons go quiet for the duration.
  useEffect(() => { onRunningChange?.(running); }, [running, onRunningChange]);

  // Poll only while something is running, and only while the tab is visible —
  // `useAutoRefetch` gives both, which matters for a queue deliberately left
  // running in a background tab all night.
  useAutoRefetch(async () => {
    const next = await refresh();
    // The report is only worth re-reading once the queue is done — mid-sweep it
    // would re-rank on partial evidence every five seconds.
    if (next && !isRunning(next)) notifyFinished();
  }, POLL_MS, { enabled: running, immediate: false, pollOnly: true });

  // Per-sample frames from the model in flight, on the same channel the
  // single-model run and model pulls use — hence the scope filter, or a
  // background model download would drive this line.
  useEffect(() => {
    const handleProgress = (frame) => {
      if (!mountedRef.current) return;
      if (frame?.scope !== 'assessment' && frame?.scope !== 'assessment-sweep') return;
      if (frame.event === 'complete' && frame.scope === 'assessment-sweep') {
        // Terminal frame for the QUEUE (not for one model): pull the final
        // snapshot and let the parent re-read the now-complete report.
        setMessage('');
        refresh().then(notifyFinished);
        return;
      }
      if (frame.message) setMessage(frame.message);
      // The counter moves when a model starts — and the frame already carries the
      // new numbers, so take them from it rather than paying a round-trip per
      // model for data we were just handed.
      if (frame.event === 'model-start') {
        setStatus((prev) => (prev ? {
          ...prev,
          completed: frame.completed ?? prev.completed,
          total: frame.total ?? prev.total,
          current: { backend: frame.backend, modelId: frame.modelId },
        } : prev));
      }
    };
    socket.on('localLlm:progress', handleProgress);
    return () => socket.off('localLlm:progress', handleProgress);
  }, [mountedRef, refresh, notifyFinished]);

  const [start, starting] = useAsyncAction(async () => {
    finishNotifiedRef.current = false;
    const next = await startLocalLlmAssessmentSweep({ scope });
    setStatus(next);
    setShowConsent(false);
    toast.success(`Sweep started — ${next.total} model${next.total === 1 ? '' : 's'} queued`);
    return next;
  }, { errorMessage: 'Could not start the sweep' });

  const [stop, stopping] = useAsyncAction(async () => {
    setStatus(await cancelLocalLlmAssessmentSweep());
    // Whatever it measured before stopping is real evidence, so the report has
    // to catch up rather than waiting for the next mount.
    notifyFinished();
    return true;
  }, { errorMessage: 'Could not stop the sweep' });

  const openConsent = () => {
    // Default to the scope that has something to do, so the common case is one
    // click: never-measured first, then stale, then everything.
    const firstUseful = SCOPES.find((s) => (counts?.[s.id] ?? 0) > 0)?.id || 'unmeasured';
    setScope(firstUseful);
    setShowConsent(true);
  };

  const totalTargets = counts?.all ?? 0;
  const finished = status && !running && status.status !== 'idle';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {running ? (
          <button
            onClick={stop}
            disabled={stopping}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-port-border text-gray-200 hover:border-port-error hover:text-port-error transition-colors disabled:opacity-50"
          >
            <Square size={12} /> Stop sweep
          </button>
        ) : (
          <button
            onClick={openConsent}
            disabled={disabled || totalTargets === 0}
            title={totalTargets === 0 ? 'No models are listable to measure right now' : 'Measure every installed model, one after another'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent hover:bg-port-accent/80 text-port-on-accent font-medium transition-colors disabled:opacity-50"
          >
            <PlayCircle size={13} /> Measure all models
          </button>
        )}
        {running && (
          <span className="text-[11px] text-gray-400 flex items-center gap-1.5" aria-live="polite">
            <BrailleSpinner />
            {status.completed}/{status.total} measured
            {status.current && <span className="text-gray-500 font-mono break-all">· {status.current.modelId}</span>}
          </span>
        )}
        {finished && (
          <span className="text-[11px] text-gray-500">
            Last sweep {status.status} — {status.completed}/{status.total} measured {timeAgo(status.finishedAt, '')}
          </span>
        )}
      </div>

      {running && (
        <div className="border border-port-border rounded-lg p-3 space-y-1.5">
          {status.total > 0 && (
            <ProgressBar
              percent={(status.completed / status.total) * 100}
              track="border"
              label={`Sweep progress: ${status.completed} of ${status.total} models measured`}
            />
          )}
          {message && <p className="text-[11px] text-gray-400 break-words" aria-live="polite">{message}</p>}
          <p className="text-[10px] text-gray-600">
            Running on the server — you can close this tab and read the results in the morning.
          </p>
        </div>
      )}

      {/* Results stay on screen after the queue ends: the whole point of an
          overnight run is reading what it found the next day. */}
      {status?.results?.length > 0 && (
        <details className="border border-port-border rounded-lg" open={running}>
          <summary className="px-3 py-2 text-xs text-gray-300 cursor-pointer hover:text-white">
            Sweep results ({status.results.length})
          </summary>
          <div className="px-3 pb-3 space-y-1">
            {status.results.map((result) => (
              <SweepResultRow key={`${result.backend}:${result.modelId}:${result.finishedAt}`} result={result} />
            ))}
          </div>
        </details>
      )}

      {status?.error && (
        <p className="text-xs text-port-warning flex items-center gap-1.5" role="alert">
          <AlertTriangle size={12} /> The sweep stopped early: {status.error}
        </p>
      )}

      {showConsent && (
        <SweepConsentModal
          scope={scope}
          onScopeChange={setScope}
          counts={counts}
          contextTokens={contextTokens}
          starting={starting}
          onCancel={() => setShowConsent(false)}
          onConfirm={start}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Brain, Check, CirclePause, CirclePlay, MessageCircle, RefreshCw, Settings2, Square, Upload } from 'lucide-react';
import useMounted from '../../../hooks/useMounted';
import { useSocket } from '../../../hooks/useSocket';
import { uuidv4 } from '../../../lib/uuid.js';
import * as api from '../../../services/api';
import { formatDateTime } from '../../../utils/formatters';
import BrailleSpinner from '../../BrailleSpinner';
import Banner from '../../ui/Banner';
import TabPills from '../../ui/TabPills';
import PersistentMindContextPanel from '../PersistentMindContextPanel';
import PersistentMindProfileControls from '../PersistentMindProfileControls';
import PersistentMindRuntimePanel, { PersistentMindThoughtStatus } from '../PersistentMindRuntimePanel';
import PersistentMindTaskAccessControls from '../PersistentMindTaskAccessControls';

const PAGE_LIMIT = 200;
const MAX_BACKFILL_PAGES = 5;
const MAX_VISIBLE_EVENTS = PAGE_LIMIT * MAX_BACKFILL_PAGES;
const MIND_VIEWS = new Set(['conversation', 'context', 'setup']);
const MIND_TABS = [
  { id: 'conversation', label: 'Conversation', icon: MessageCircle },
  { id: 'context', label: 'Context & memory', icon: Brain },
  { id: 'setup', label: 'Provider & lifecycle', icon: Settings2 },
];

const EVENT_LABELS = {
  'mind.message.accepted': 'User input',
  'mind.annotation.accepted': 'Annotation',
  'mind.summary': 'Mind summary',
  'mind.model.result': 'Mind summary',
  'mind.turn.completed': 'Mind summary',
  'mind.thought': 'Working note',
  'mind.reply': 'Chief of Staff',
  'mind.memory.candidate': 'Memory proposal',
  'mind.capability.request': 'Action request',
  'mind.capability.result': 'Action outcome',
  'mind.memory.promoted': 'Memory promoted',
};

const eventLabel = (kind) => EVENT_LABELS[kind] || 'System state';
const eventText = (event) => {
  const data = event?.data || {};
  if (typeof data.displayText === 'string') return data.displayText;
  if (typeof data.summaryText === 'string') return data.summaryText;
  if (event?.kind === 'mind.failed') return data.status === 'interrupted'
    ? 'The previous wake was interrupted'
    : 'The provider was unavailable or the wake failed';
  if (event?.kind === 'mind.paused') return data.status === 'idle'
    ? 'The persistent mind was stopped'
    : 'The persistent mind was paused';
  if (event?.kind === 'mind.capability.request' && typeof data.capabilityId === 'string') {
    return `Capability request ${data.capabilityId}`;
  }
  if (typeof data.status === 'string') return data.status;
  return null;
};

const mergeEvents = (previous, incoming) => {
  const byId = new Map(previous.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence).slice(-MAX_VISIBLE_EVENTS);
};

const mintId = (prefix) => `${prefix}-${uuidv4()}`;

export default function MindTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedEventId = searchParams.get('event');
  const activeView = MIND_VIEWS.has(searchParams.get('view')) ? searchParams.get('view') : 'conversation';
  const socket = useSocket();
  const [events, setEvents] = useState(null);
  const [mind, setMind] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [gap, setGap] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState('message');
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [lifecyclePending, setLifecyclePending] = useState(null);
  const [eventActionPending, setEventActionPending] = useState(null);
  const [lifecycleError, setLifecycleError] = useState(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [taskAccessSaving, setTaskAccessSaving] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [runtime, setRuntime] = useState(null);
  const [runtimeError, setRuntimeError] = useState(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const cursorRef = useRef(null);
  const loadPendingRef = useRef(false);
  const deferredLoadRef = useRef(false);
  const runtimePendingRef = useRef(false);
  const deferredRuntimeRef = useRef(false);
  const runtimeLoadedRef = useRef(false);
  const runtimeMountedRef = useMounted();
  const draftIdRef = useRef(null);

  const loadHistory = useCallback(async ({ reset = false } = {}) => {
    if (loadPendingRef.current) {
      deferredLoadRef.current = true;
      return;
    }
    loadPendingRef.current = true;
    if (reset) setLoading(true);
    let cursor = reset ? null : cursorRef.current;
    let page = 0;
    let accumulated = [];
    let sawGap = false;
    let sawTruncation = false;
    let needsMore = false;
    try {
      do {
        const response = await api.getPersistentMind({ cursor, limit: PAGE_LIMIT }, { silent: true });
        accumulated = mergeEvents(accumulated, response.events || []);
        sawGap ||= response.gap === true;
        sawTruncation ||= response.truncated === true;
        cursor = response.gap === true ? response.cursor : response.cursor || cursor;
        setMind({
          state: response.state,
          profile: response.profile,
          capabilities: response.capabilities,
          autonomyMode: response.autonomyMode,
        });
        page += 1;
        needsMore = response.hasMore === true && !sawGap;
        if (!needsMore) break;
      } while (page < MAX_BACKFILL_PAGES);
      cursorRef.current = cursor;
      setEvents((previous) => reset || sawGap || previous === null ? accumulated : mergeEvents(previous, accumulated));
      setGap(sawGap);
      setTruncated((current) => reset ? sawTruncation : current || sawTruncation);
      setLoadError(null);
      if (needsMore) deferredLoadRef.current = true;
    } catch (error) {
      setLoadError(error?.message || 'Could not load the persistent mind');
    } finally {
      setLoading(false);
      loadPendingRef.current = false;
      if (deferredLoadRef.current) {
        deferredLoadRef.current = false;
        void loadHistory();
      }
    }
  }, []);

  const loadRuntime = useCallback(async () => {
    if (runtimePendingRef.current) {
      deferredRuntimeRef.current = true;
      return;
    }
    runtimePendingRef.current = true;
    if (!runtimeLoadedRef.current) setRuntimeLoading(true);
    try {
      const response = await api.getPersistentMindRuntime({ silent: true });
      if (!runtimeMountedRef.current) return;
      setRuntime(response);
      runtimeLoadedRef.current = true;
      setRuntimeError(null);
    } catch (error) {
      if (runtimeMountedRef.current) {
        setRuntimeError(error?.message || 'Could not refresh runtime telemetry');
      }
    } finally {
      if (runtimeMountedRef.current) setRuntimeLoading(false);
      runtimePendingRef.current = false;
      if (runtimeMountedRef.current && deferredRuntimeRef.current) {
        deferredRuntimeRef.current = false;
        void loadRuntime();
      }
    }
  }, []);

  useEffect(() => { void loadHistory({ reset: true }); }, [loadHistory]);
  useEffect(() => {
    void loadRuntime();
    const interval = setInterval(() => { void loadRuntime(); }, 10_000);
    return () => clearInterval(interval);
  }, [loadRuntime]);

  useEffect(() => {
    const refresh = () => {
      void loadHistory();
      void loadRuntime();
    };
    socket.on('connect', refresh);
    socket.on('cos:mind:event', refresh);
    socket.on('cos:mind:status', refresh);
    return () => {
      socket.off('connect', refresh);
      socket.off('cos:mind:event', refresh);
      socket.off('cos:mind:status', refresh);
    };
  }, [loadHistory, loadRuntime, socket]);

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    const id = draftIdRef.current || mintId(kind);
    draftIdRef.current = id;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (kind === 'message') {
        await api.sendPersistentMindMessage({ id, text: trimmed }, { silent: true });
      } else {
        await api.addPersistentMindAnnotation({
          id,
          text: trimmed,
          targetEventId: selectedEventId || null,
        }, { silent: true });
      }
      const sequence = Math.max(-1, ...(events || []).map((item) => item.sequence || -1)) + 1;
      setEvents((previous) => mergeEvents(previous || [], [{
        eventId: `mind-${kind === 'message' ? 'message' : 'annotation'}:${id}`,
        kind: kind === 'message' ? 'mind.message.accepted' : 'mind.annotation.accepted',
        mindId: 'cos-persistent-mind',
        turnId: null,
        sequence,
        at: new Date().toISOString(),
        data: {
          displayText: trimmed,
          ...(kind === 'annotation' ? { annotationId: id, targetEventId: selectedEventId || null } : { messageId: id }),
        },
      }]));
      setText('');
      draftIdRef.current = null;
      await loadHistory();
      void loadRuntime();
    } catch (error) {
      setSubmitError(error?.message || 'The input was not accepted');
    } finally {
      setSubmitting(false);
    }
  };

  const changeKind = (next) => {
    setKind(next);
    draftIdRef.current = null;
    setSubmitError(null);
  };

  const changeText = (next) => {
    if (submitError) {
      draftIdRef.current = null;
      setSubmitError(null);
    }
    setText(next);
  };

  const runLifecycle = async (action) => {
    setLifecyclePending(action);
    setLifecycleError(null);
    try {
      if (action === 'start') await api.startPersistentMind({ silent: true });
      if (action === 'pause') await api.pausePersistentMind('Paused from Mind page', { silent: true });
      if (action === 'resume') await api.resumePersistentMind({ silent: true });
      if (action === 'stop') await api.stopPersistentMind({ silent: true });
      await loadHistory();
      void loadRuntime();
    } catch (error) {
      setLifecycleError(error?.message || `Could not ${action} the persistent mind`);
    } finally {
      setLifecyclePending(null);
    }
  };

  const acknowledge = async (event) => {
    if (eventActionPending) return;
    setEventActionPending(event.eventId);
    setLifecycleError(null);
    try {
      await api.acknowledgePersistentMindEvent(event.eventId, `ack-${event.eventId}`, { silent: true });
      await loadHistory();
    } catch (error) {
      setLifecycleError(error?.message || 'Could not acknowledge the action');
    } finally {
      setEventActionPending(null);
    }
  };

  const promote = async (event) => {
    const content = eventText(event);
    if (!content || eventActionPending) return;
    setEventActionPending(event.eventId);
    setLifecycleError(null);
    try {
      await api.promotePersistentMindEvent(event.eventId, {
        id: `promotion-${event.eventId}`, approved: true, content, summary: content.slice(0, 500), type: 'insight', category: 'other',
      }, { silent: true });
      await loadHistory();
    } catch (error) {
      setLifecycleError(error?.message || 'Could not promote the action');
    } finally {
      setEventActionPending(null);
    }
  };

  const state = mind?.state;
  const selectedEvent = events?.find((event) => event.eventId === selectedEventId) || null;
  const isPaused = state?.status === 'paused';
  const profileReady = Boolean(mind?.profile?.enabled && mind.profile.providerId && mind.profile.model);
  const setupSaving = profileSaving || taskAccessSaving;
  const visibleEvents = (events || []).filter((event) => showActivity || ![
    'mind.wake', 'mind.model.request', 'mind.model.result', 'mind.turn.completed',
  ].includes(event.kind));
  const changeView = (view) => setSearchParams((current) => {
    const next = new URLSearchParams(current);
    if (view === 'conversation') next.delete('view');
    else next.set('view', view);
    return next;
  });

  return (
    <section aria-labelledby="mind-heading" className="space-y-4">
      <header className="flex flex-col gap-3 rounded border border-port-border bg-port-card p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="mind-heading" className="flex items-center gap-2 text-lg font-semibold text-port-text">
            <MessageCircle size={20} aria-hidden="true" /> Persistent Mind
          </h2>
          <p className="mt-1 text-sm text-port-text-muted">One durable, machine-local conversation with the resident Chief of Staff mind.</p>
          <p className="mt-2 text-xs text-port-text-muted">
            {mind ? `${mind.profile?.providerId || 'No provider'} · ${mind.profile?.model || 'No model'} · ${mind.profile?.effort || 'provider default'} · autonomy ${mind.autonomyMode}` : 'Profile unavailable'}
          </p>
          <div className="mt-3">
            <PersistentMindThoughtStatus
              state={state}
              model={state?.activeTurnId && state.activeTurnId === runtime?.inference?.turnId
                ? runtime.inference.model
                : mind?.profile?.model}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Persistent mind lifecycle">
          {state?.started && !isPaused && <ActionButton label="Pause" icon={CirclePause} pending={lifecyclePending === 'pause'} onClick={() => runLifecycle('pause')} />}
          {state?.started && isPaused && <ActionButton label="Resume" icon={CirclePlay} pending={lifecyclePending === 'resume'} onClick={() => runLifecycle('resume')} />}
          {state?.started && <ActionButton label="Stop" icon={Square} pending={lifecyclePending === 'stop'} onClick={() => runLifecycle('stop')} />}
          <ActionButton label="Reload" icon={RefreshCw} pending={loading || runtimeLoading} onClick={() => {
            void loadHistory({ reset: true });
            void loadRuntime();
          }} />
        </div>
      </header>

      <TabPills tabs={MIND_TABS} activeTab={activeView} onChange={changeView} variant="pills" mobileDropdown mobileSelectId="persistent-mind-view" ariaLabel="Persistent mind view" />

      {gap && <Banner tone="warning" title="History gap detected">The saved cursor is no longer retained. The visible trace was reloaded from the newest bounded snapshot.</Banner>}
      {truncated && <Banner tone="info" title="Showing recent history">The initial trace shows the newest {PAGE_LIMIT} events; older retained events are not shown.</Banner>}
      {loadError && <Banner tone="error" title="Conversation unavailable">{loadError}. Existing messages are preserved; retry when the connection recovers.</Banner>}
      {lifecycleError && <Banner tone="error" title="Action failed">{lifecycleError}</Banner>}

      <PersistentMindRuntimePanel runtime={runtime} error={runtimeError} loading={runtimeLoading} onOpenContext={() => changeView('context')} />

      {activeView === 'setup' && (
        <section aria-labelledby="mind-profile-heading" className="rounded border border-port-border bg-port-card p-4">
          <div className="mb-3">
            <h3 id="mind-profile-heading" className="text-sm font-semibold text-port-text">AI profile</h3>
            <p className="mt-1 text-xs text-port-text-muted">Pin the provider, model, and effort used on every wake. Changes apply to the next wake and never silently fall back to another model.</p>
          </div>
          <PersistentMindProfileControls
            profile={mind?.profile}
            disabled={!mind}
            onSaved={(profile) => setMind((current) => current ? { ...current, profile } : current)}
            onSavingChange={setProfileSaving}
          />
          <div className="mt-4 border-t border-port-border pt-4">
            <h3 className="text-sm font-semibold text-port-text">Agent task access</h3>
            <p className="mb-3 mt-1 text-xs text-port-text-muted">Choose whether this mind may turn a concrete recommendation into a typed task with its own run profile and landing gate.</p>
            <PersistentMindTaskAccessControls
              capabilities={mind?.capabilities}
              disabled={!mind}
              onSaved={(capabilities) => setMind((current) => current ? { ...current, capabilities } : current)}
              onSavingChange={setTaskAccessSaving}
            />
          </div>
          {!state?.started && (
            <div className="mt-4 flex flex-col gap-2 border-t border-port-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-port-text-muted">{setupSaving ? 'Saving persistent mind settings…' : profileReady ? 'The saved AI profile is ready.' : 'Enable the profile and select both an AI provider and model to start.'}</p>
              <ActionButton label="Start persistent mind" icon={CirclePlay} pending={lifecyclePending === 'start'} disabled={loading || setupSaving || !profileReady} onClick={() => runLifecycle('start')} />
            </div>
          )}
        </section>
      )}

      {activeView === 'context' && <PersistentMindContextPanel />}

      {activeView === 'conversation' && (
        <>
          <div data-testid="mind-layout" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)]">
            <div className="min-w-0 rounded border border-port-border bg-port-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-port-border px-4 py-3 text-sm text-port-text-muted">
                <span>
                  Status: <span className="font-medium text-port-text">{state?.status || 'unknown'}</span>
                  {state?.pauseReason ? ` · ${state.pauseReason}` : ''}
                  {state?.queuedMessageCount > 0 ? ` · ${state.queuedMessageCount} queued` : ''}
                  {state?.failureCount > 0 ? ` · ${state.failureCount} failed wake${state.failureCount === 1 ? '' : 's'}` : ''}
                  {state?.nextEligibleWakeAt ? ` · retry after ${formatDateTime(state.nextEligibleWakeAt)}` : ''}
                  {state?.lastError ? ` · ${state.lastError}` : ''}
                </span>
                <label htmlFor="mind-show-activity" className="flex items-center gap-2 text-xs">
                  <input id="mind-show-activity" type="checkbox" checked={showActivity} onChange={(event) => setShowActivity(event.target.checked)} className="accent-port-accent" /> Show run activity
                </label>
              </div>
              {loading && events === null ? (
                <div className="flex justify-center p-10"><BrailleSpinner text="Loading mind history" /></div>
              ) : visibleEvents.length === 0 && !loadError ? (
                <p className="p-8 text-center text-sm text-port-text-muted">No conversation yet. Add a message below, or start the mind from Provider & lifecycle.</p>
              ) : (
                <ol className="max-h-[62vh] space-y-3 overflow-y-auto p-3" aria-label="Persistent mind conversation">
                  {visibleEvents.map((event) => {
                    const selected = event.eventId === selectedEventId;
                    const textValue = eventText(event);
                    const assistant = event.kind === 'mind.reply';
                    const thought = event.kind === 'mind.thought';
                    return (
                      <li key={event.eventId} className={assistant ? 'flex justify-end' : ''}>
                        <button
                          type="button"
                          onClick={() => setSearchParams((current) => {
                            const next = new URLSearchParams(current);
                            next.set('event', event.eventId);
                            return next;
                          })}
                          aria-current={selected ? 'true' : undefined}
                          className={`${assistant ? 'max-w-[88%] border-port-accent/50 bg-port-accent/10' : 'w-full'} rounded border p-3 text-left ${thought ? 'border-dashed border-port-accent/40 bg-port-bg/40' : ''} ${selected ? 'ring-1 ring-port-accent' : 'hover:bg-port-border/20'} ${!assistant && !thought ? 'border-port-border' : ''}`}
                        >
                          <span className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-port-accent">{eventLabel(event.kind)}</span>
                            <time className="text-xs text-port-text-muted" dateTime={event.at}>{formatDateTime(event.at)}</time>
                          </span>
                          <span className="mt-1 block whitespace-pre-wrap break-words text-sm text-port-text">{textValue || event.kind}</span>
                          {event.turnId && <span className="mt-1 block truncate font-mono text-[11px] text-port-text-muted">turn {event.turnId}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            <aside className="space-y-3 rounded border border-port-border bg-port-card p-4" aria-label="Selected mind event">
              <h3 className="text-sm font-semibold text-port-text">Selected event</h3>
              {selectedEvent ? (
                <>
                  <p className="break-all font-mono text-xs text-port-text-muted">{selectedEvent.eventId}</p>
                  <p className="text-sm text-port-text">{eventLabel(selectedEvent.kind)}</p>
                  <p className="text-xs text-port-text-muted">Sequence {selectedEvent.sequence}{selectedEvent.turnId ? ` · turn ${selectedEvent.turnId}` : ''}</p>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-port-border bg-port-bg p-2 text-[11px] text-port-text-muted">{JSON.stringify(selectedEvent.data || {}, null, 2)}</pre>
                  {selectedEvent.kind === 'mind.capability.request' && <ActionButton label="Acknowledge" icon={Check} pending={eventActionPending === selectedEvent.eventId} onClick={() => acknowledge(selectedEvent)} />}
                  {['mind.summary', 'mind.reply', 'mind.thought', 'mind.memory.candidate'].includes(selectedEvent.kind) && (
                    <ActionButton label="Promote to memory" icon={Upload} pending={eventActionPending === selectedEvent.eventId} disabled={!eventText(selectedEvent)} onClick={() => promote(selectedEvent)} />
                  )}
                </>
              ) : <p className="text-sm text-port-text-muted">Choose an item to inspect its safe event payload, keep it selected in the URL, attach an annotation, or promote it to memory.</p>}
            </aside>
          </div>

          <form onSubmit={submit} className="rounded border border-port-border bg-port-card p-4">
            <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <div>
                <label htmlFor="mind-input-kind" className="mb-1 block text-sm font-medium text-port-text">Input type</label>
                <select id="mind-input-kind" value={kind} onChange={(event) => changeKind(event.target.value)} className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text">
                  <option value="message">Message</option>
                  <option value="annotation">Comment / idea</option>
                </select>
              </div>
              <div>
                <label htmlFor="mind-input-text" className="mb-1 block text-sm font-medium text-port-text">{kind === 'message' ? 'Message' : 'Comment or idea'}</label>
                <textarea id="mind-input-text" value={text} onChange={(event) => changeText(event.target.value)} maxLength={8000} rows={3} className="w-full resize-y rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text" placeholder={kind === 'message' ? 'Write directly into the persistent conversation…' : 'Add context without requesting an immediate reply.'} />
              </div>
            </div>
            {kind === 'annotation' && selectedEventId && <p className="mt-2 text-xs text-port-text-muted">Attached to selected event {selectedEventId}</p>}
            {submitError && <p role="alert" className="mt-2 text-sm text-port-error">{submitError} — Retry uses the same id, so it will not duplicate the input.</p>}
            <div className="mt-3 flex justify-end">
              <button type="submit" disabled={!text.trim() || submitting} className="rounded bg-port-accent px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{submitting ? 'Sending…' : submitError ? 'Retry' : kind === 'message' ? 'Send message' : 'Add annotation'}</button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}

function ActionButton({ label, icon: Icon, pending = false, disabled = false, onClick }) {
  return (
    <button type="button" disabled={pending || disabled} onClick={onClick} className="flex min-h-[36px] items-center gap-2 rounded border border-port-border px-3 py-1.5 text-sm text-port-text hover:bg-port-border/30 disabled:cursor-not-allowed disabled:opacity-50">
      <Icon size={16} className={pending ? 'animate-spin' : ''} aria-hidden="true" /> {pending ? `${label}…` : label}
    </button>
  );
}

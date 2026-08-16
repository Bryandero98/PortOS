import { useState, useEffect, useCallback, useMemo, useId, useRef } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle, Bot, ChevronDown, ChevronRight, CircleDot, ExternalLink,
  Loader2, RefreshCw, Rocket, Search, User
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import Banner from '../../ui/Banner';
import Pill from '../../ui/Pill';
import toast from '../../ui/Toast';
import ProviderModelSelector from '../../ProviderModelSelector';
import useProviderModels from '../../../hooks/useProviderModels';
import { isProcessProvider } from '../../../utils/providers';
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import { timeAgo } from '../../../utils/formatters';

const FORGE_LABEL = { github: 'GitHub', gitlab: 'GitLab' };

const CLAIM_STATUS_RANK = { queuing: 0, queued: 1, active: 2, completed: 3, blocked: 3 };
const CLAIM_STATUS_LABEL = {
  queued: 'Queued — view',
  active: 'Active — view',
  completed: 'Completed — view',
  blocked: 'Blocked — view'
};

const claimStatusForTask = (status) => ({
  pending: 'queued',
  in_progress: 'active',
  completed: 'completed',
  blocked: 'blocked'
}[status] || null);

// Module-scoped so `useProviderModels` sees a stable predicate — an inline
// arrow would be a new identity every render, re-firing the hook's fetch
// effect forever. Matches SlashDoRunDrawer's filter: only CODING providers
// (CLI/TUI agents with a file-writing harness) can run a `/do:next` claim.
const enabledProcessProviderFilter = (p) => Boolean(p?.enabled) && isProcessProvider(p);

// Why the forge returned nothing, in the user's terms. Sentinel-aware: a
// definitive "no open issues" and a failed probe are different sentences, so an
// unreachable CLI can never read as an empty tracker.
const EMPTY_REASONS = {
  'no-repo-path': 'This app has no repo path configured.',
  'unsupported-forge': 'This app\'s git origin isn\'t GitHub or GitLab, so there are no forge issues to list.',
  'tracker-not-a-forge': 'This app\'s Work Tracker isn\'t a forge issue tracker, so a claim here wouldn\'t touch forge issues. Change it under Edit App → Workflow.',
  'tracker-forge-mismatch': 'This app\'s Work Tracker is pinned to a different forge than its git origin, so neither list would match what a claim runs against. Reconcile them under Edit App → Workflow.',
  'no-open-issues': 'No open issues on this tracker.'
};

/**
 * Label chips carry the forge's own color, which is arbitrary per-repo data —
 * so it can't be a Tailwind class (those must be literal strings in source).
 * Render it as a tinted chip via inline style: the color for text and border,
 * a low-alpha wash of it for the background, which stays legible on the dark
 * surface for the full hue range. A label with no color falls back to `muted`.
 */
function LabelChip({ label }) {
  return (
    <Pill
      size="xs"
      tone={label.color ? 'bare' : 'muted'}
      title={label.description || undefined}
      style={label.color ? {
        color: label.color,
        borderColor: `${label.color}66`,
        backgroundColor: `${label.color}1a`
      } : undefined}
    >
      {label.name}
    </Pill>
  );
}

/**
 * Open issues from the app's forge (GitHub or GitLab, resolved from the git
 * `origin` remote), each with its labels, assignees, expandable description, and
 * a one-click "Claim with CoS agent" button.
 *
 * Claiming queues the SAME `/do:next` task the Agent Operations panel does,
 * pinned to this issue via `target` — so the run honors the app's configured
 * Work Tracker, worktree, and PR settings instead of a parallel code path.
 */
export default function IssuesTab({ appId, appName }) {
  const searchId = useId();
  const overrideContextId = useId();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  // Per-issue claim lifecycle: 'queuing' while the POST is in flight, then the
  // task's live CoS state. Keyed by issue number so one claim can't disable
  // every other row's button.
  const [claims, setClaims] = useState({});
  const claimsRef = useRef({});
  // Generation guard: a forge list can take seconds, so a Refresh (or a switch to
  // a different app, which updates this component in place rather than
  // remounting it) can leave an older request in flight. Without this, that older
  // response lands last and shows one app's issues under another's Claim buttons.
  const requestRef = useRef(0);

  // Page-level provider/model/effort pin for every Claim button on this tab —
  // left untouched (blank), a claim resolves the install's active provider,
  // same as the bare button always did (POST /tasks/slashdo -> resolveAgentProviderAndModel;
  // this manual path does NOT consult the app's scheduled claim-work override —
  // that's a separate resolution used only by the automated claim-work task).
  // This picker never persists across a reload; it's a session convenience for
  // "claim the next several issues with model X" without reopening the Agent
  // Operations drawer each time.
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel
  } = useProviderModels({ filter: enabledProcessProviderFilter, allowDefault: true, silent: true, withEffort: true });
  const [effort, setEffort] = useState('');
  const [overrideContext, setOverrideContext] = useState('');

  // Keep the event-driven path based on the latest claims without putting a
  // mutable state snapshot in its effect dependencies. Socket callbacks can
  // arrive between the POST response and the next React render.
  const replaceClaims = useCallback((updater) => {
    const next = updater(claimsRef.current);
    claimsRef.current = next;
    setClaims(next);
  }, []);

  useEffect(() => {
    claimsRef.current = {};
    setClaims({});
    setOverrideContext('');
  }, [appId]);

  useEffect(() => {
    const subscribe = () => socket.emit('cos:subscribe');
    if (socket.connected) subscribe();
    socket.on('connect', subscribe);

    const applyTaskUpdate = (task) => {
      if (!task?.id) return;
      const nextStatus = claimStatusForTask(task.status);
      if (!nextStatus) return;

      const currentClaims = claimsRef.current;
      const nextClaims = { ...currentClaims };
      const transitions = [];

      for (const [issueNumber, rawClaim] of Object.entries(currentClaims)) {
        const claim = typeof rawClaim === 'string' ? { status: rawClaim } : rawClaim;
        const matchesTask = claim.taskId === task.id || (
          !claim.taskId && task.metadata?.app === appId &&
          String(task.metadata?.claimTarget) === issueNumber
        );
        if (!matchesTask) continue;

        const currentStatus = claim.status || 'queuing';
        if ((CLAIM_STATUS_RANK[nextStatus] ?? 0) < (CLAIM_STATUS_RANK[currentStatus] ?? 0)) continue;
        if (claim.taskId === task.id && currentStatus === nextStatus) continue;

        nextClaims[issueNumber] = { ...claim, taskId: claim.taskId || task.id, status: nextStatus };
        transitions.push({ issueNumber, from: currentStatus, to: nextStatus });
      }

      if (transitions.length === 0) return;
      replaceClaims(() => nextClaims);

      for (const { issueNumber, from, to } of transitions) {
        if (to === 'active' && from !== 'active') toast(`Claim #${issueNumber} is now active`, { icon: '▶️' });
        if (to === 'completed' && from !== 'completed') toast.success(`Claim #${issueNumber} completed`);
        if (to === 'blocked' && from !== 'blocked') toast.error(`Claim #${issueNumber} was blocked`);
      }
    };

    const handleTaskChanged = (data) => applyTaskUpdate(data?.task);
    const handleTaskListChanged = (data) => {
      for (const task of data?.tasks || []) applyTaskUpdate(task);
    };
    const handleTaskCompleted = (data) => {
      for (const task of data?.tasks || []) applyTaskUpdate(task);
    };
    const handleAgentSpawned = (agent) => {
      if (agent?.taskId) applyTaskUpdate({ id: agent.taskId, status: 'in_progress' });
    };
    const handleAgentCompleted = (agent) => {
      // A failed agent can be requeued or blocked by its completion path, so
      // only the success signal is safe as an early terminal hint. The task
      // lifecycle event below remains authoritative for all outcomes.
      if (agent?.taskId && agent.result?.success === true) {
        applyTaskUpdate({ id: agent.taskId, status: 'completed' });
      }
    };

    socket.on('cos:tasks:changed', handleTaskChanged);
    socket.on('cos:tasks:user:changed', handleTaskListChanged);
    socket.on('cos:tasks:user:completed', handleTaskCompleted);
    socket.on('cos:agent:spawned', handleAgentSpawned);
    socket.on('cos:agent:completed', handleAgentCompleted);

    return () => {
      socket.off('connect', subscribe);
      socket.off('cos:tasks:changed', handleTaskChanged);
      socket.off('cos:tasks:user:changed', handleTaskListChanged);
      socket.off('cos:tasks:user:completed', handleTaskCompleted);
      socket.off('cos:agent:spawned', handleAgentSpawned);
      socket.off('cos:agent:completed', handleAgentCompleted);
    };
  }, [appId, replaceClaims]);

  const load = useCallback(async () => {
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    const isCurrent = () => requestRef.current === generation;

    setLoading(true);
    setError('');
    const result = await api.getAppIssues(appId).catch(err => {
      if (isCurrent()) setError(err?.message || 'Failed to load issues');
      return null;
    });
    if (!isCurrent()) return;
    setLoading(false);
    // A failed refresh keeps the last good list rather than blanking it.
    if (result) setData(result);
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  // Lowercase each issue's searchable text ONCE per fetch, not once per
  // keystroke: bodies are capped at 8000 chars and the list at 200 issues, so
  // re-deriving inside the filter churned up to 1.6 MB of throwaway strings on
  // every character typed. Digits are case-invariant, so the issue number folds
  // into the same haystack.
  const haystacks = useMemo(() => (data?.issues || []).map(issue => ({
    issue,
    hay: [
      String(issue.number),
      issue.title,
      issue.body || '',
      issue.labels.map(l => l.name).join(' '),
      issue.assignees.join(' ')
    ].join('\n').toLowerCase()
  })), [data]);

  const issues = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? haystacks.filter(h => h.hay.includes(q)) : haystacks;
    return rows.map(h => h.issue);
  }, [haystacks, query]);

  const total = data?.issues?.length ?? 0;

  const toggleExpanded = (number) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(number)) next.delete(number); else next.add(number);
    return next;
  });

  const handleClaim = async (issue) => {
    replaceClaims(prev => ({ ...prev, [issue.number]: { status: 'queuing', taskId: null } }));
    const trimmedOverrideContext = overrideContext.trim();
    const result = await api.createSlashdoTask('next', appId, {
      target: String(issue.number),
      issueContext: {
        number: issue.number,
        title: issue.title || '',
        body: issue.body || '',
        ...(issue.url ? { url: issue.url } : {})
      },
      provider: selectedProviderId || undefined,
      model: selectedModel || undefined,
      effort: effort || undefined,
      ...(trimmedOverrideContext ? { overrideContext: trimmedOverrideContext } : {}),
    }, { silent: true })
      .catch(err => {
        toast.error(err?.message || `Failed to queue a claim for #${issue.number}`);
        return null;
      });
    if (!result) {
      replaceClaims(prev => {
        const next = { ...prev };
        delete next[issue.number];
        return next;
      });
      return;
    }
    replaceClaims(prev => {
      const current = prev[issue.number];
      const currentStatus = typeof current === 'string' ? current : current?.status;
      const resultStatus = claimStatusForTask(result.status) || 'queued';
      const status = (CLAIM_STATUS_RANK[resultStatus] ?? 0) >= (CLAIM_STATUS_RANK[currentStatus] ?? 0)
        ? resultStatus
        : currentStatus;
      return {
        ...prev,
        [issue.number]: {
          ...(typeof current === 'object' ? current : {}),
          status,
          taskId: current?.taskId || result.id || null
        }
      };
    });
    toast.success(`Queued a CoS agent to claim #${issue.number}`);
  };

  if (loading && !data) return <BrailleSpinner text="Loading issues" />;

  const forgeLabel = FORGE_LABEL[data?.forge] || 'Issues';
  // A transient failure keeps the "couldn't ask" framing — never the lie that
  // the tracker is empty.
  const unavailable = data?.transient === true;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-semibold text-white">
          {forgeLabel} Issues
          {data?.fullName && <span className="ml-2 text-xs font-mono text-gray-500">{data.fullName}</span>}
        </h3>
        {total > 0 && (
          <span className="text-xs text-gray-500">
            {issues.length === total ? `${total} open` : `${issues.length} of ${total} open`}
          </span>
        )}
        <div className="relative ml-auto">
          <label htmlFor={searchId} className="sr-only">Filter issues</label>
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by title, label, assignee…"
            className="w-full sm:w-72 pl-8 pr-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
          />
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="space-y-3 px-3 py-2 bg-port-card border border-port-border rounded-lg">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-wide shrink-0">
            <Bot size={14} /> Claim with
          </span>
          <div className="flex-1">
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={(id) => { setSelectedProviderId(id); setEffort(''); }}
              onModelChange={setSelectedModel}
              effort={effort}
              onEffortChange={setEffort}
              emptyProviderOption="Auto (default)"
              emptyModelOption="Default model"
              compact
              highlightToolUse
            />
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor={overrideContextId} className="block text-xs text-gray-400">
            Override context or instructions <span className="text-gray-600">(optional)</span>
          </label>
          <textarea
            id={overrideContextId}
            value={overrideContext}
            onChange={e => setOverrideContext(e.target.value)}
            maxLength={4000}
            rows={2}
            placeholder="Add guidance for this claim, such as a preferred implementation focus…"
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm placeholder:text-gray-600 focus:border-port-accent focus:outline-hidden resize-y"
          />
          <p className="text-xs text-gray-600">
            Appended to the selected claim&apos;s instructions; blank leaves the claim prompt unchanged.
          </p>
        </div>
      </div>

      {error && (
        <Banner tone="error" size="md" icon={AlertTriangle}>
          Couldn&apos;t load issues — {error}
        </Banner>
      )}

      {!error && unavailable && (
        <Banner tone="warning" size="md" icon={AlertTriangle}>
          Couldn&apos;t reach {forgeLabel} ({data.reason})
          {data.remedy ? ` — ${data.remedy}.` : ' — retry once the CLI is authenticated.'}
        </Banner>
      )}

      {!error && !unavailable && total === 0 && (
        <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg">
          {EMPTY_REASONS[data?.reason] ?? EMPTY_REASONS['no-open-issues']}
        </div>
      )}

      {/* A failed REFRESH deliberately shows the error banner above AND the last
          good list below — blanking issues the user was reading is worse than
          showing them alongside a "couldn't refresh" notice. */}
      {issues.length === 0 && total > 0 && (
        <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg">
          No open issues match &ldquo;{query}&rdquo;.
        </div>
      )}

      {issues.length > 0 && (
        <div className="border border-port-border rounded-lg divide-y divide-port-border overflow-hidden">
          {issues.map(issue => {
            const isOpen = expanded.has(issue.number);
            const claim = claims[issue.number];
            const claimState = typeof claim === 'string' ? claim : claim?.status;
            return (
              <div key={issue.number} className="bg-port-card">
                <div className="flex flex-col sm:flex-row sm:items-start gap-3 p-3">
                  <button
                    onClick={() => toggleExpanded(issue.number)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} description for issue ${issue.number}`}
                    className="hidden sm:flex text-gray-500 hover:text-white transition-colors mt-0.5 shrink-0"
                  >
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <CircleDot size={14} className="text-port-success shrink-0 self-center" />
                      <span className="text-xs font-mono text-gray-500">#{issue.number}</span>
                      <button
                        onClick={() => toggleExpanded(issue.number)}
                        aria-expanded={isOpen}
                        className="text-sm text-white text-left hover:text-port-accent transition-colors break-words"
                      >
                        {issue.title || '(no title)'}
                      </button>
                      {issue.url && (
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open issue ${issue.number} on ${forgeLabel}`}
                          className="text-gray-500 hover:text-port-accent transition-colors self-center"
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>

                    {issue.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-gray-500">
                      {issue.author && <span>opened by {issue.author}</span>}
                      {issue.updatedAt && <span>updated {timeAgo(issue.updatedAt)}</span>}
                      {issue.milestone && <span className="text-cyan-400">{issue.milestone}</span>}
                      {issue.assignees.length > 0 ? (
                        <span className="flex items-center gap-1 text-gray-300">
                          <User size={12} /> {issue.assignees.join(', ')}
                        </span>
                      ) : (
                        <span className="italic">unassigned</span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0">
                    {claimState && claimState !== 'queuing' ? (
                      <Link
                        to="/cos/agents"
                        className="px-3 py-1.5 bg-port-success/20 text-port-success hover:bg-port-success/30 border border-port-border rounded-lg text-xs flex items-center gap-1.5 transition-colors"
                      >
                        <Rocket size={14} /> {CLAIM_STATUS_LABEL[claimState] || 'Queued — view'}
                      </Link>
                    ) : (
                      <button
                        onClick={() => handleClaim(issue)}
                        disabled={claimState === 'queuing'}
                        title={`Queue a CoS agent to claim issue #${issue.number} for ${appName}`}
                        className="px-3 py-1.5 bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30 border border-port-border rounded-lg text-xs flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                      >
                        {claimState === 'queuing'
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Rocket size={14} />}
                        {claimState === 'queuing' ? 'Queuing…' : 'Claim'}
                      </button>
                    )}
                  </div>
                </div>

                {isOpen && (
                  <div className="px-3 pb-3 sm:pl-10">
                    {issue.body?.trim() ? (
                      <pre className="text-xs text-gray-300 whitespace-pre-wrap break-words font-sans bg-port-bg border border-port-border rounded-lg p-3 max-h-96 overflow-auto">
                        {issue.body}
                      </pre>
                    ) : (
                      <p className="text-xs text-gray-500 italic">No description.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

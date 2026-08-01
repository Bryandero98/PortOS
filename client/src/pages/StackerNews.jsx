import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Newspaper, Plus, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
import * as api from '../services/api';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import useLocalModels from '../hooks/useLocalModels';
import { useValidTab } from '../hooks/useValidTab';

const TABS = [
  { id: 'review', label: 'Review', icon: ShieldCheck },
  { id: 'territory', label: 'Territory', icon: Newspaper },
  { id: 'drafts', label: 'Drafts', icon: Plus },
  { id: 'activity', label: 'Activity', icon: RefreshCw },
  { id: 'accounts', label: 'Accounts & Safety', icon: ShieldAlert },
];
const emptyAccount = { label: '', username: '', apiKey: '', enabled: true, monitoringEnabled: false, monitoringIntervalMinutes: 30, analysisEnabled: false, textModel: '', visionModel: '', guidance: '', tone: '', allowedThemes: '', disallowedThemes: '', escalationCues: '', desiredEngagement: '', maxPerHour: 3, maxPerDay: 12, minMinutesBetween: 5 };
const emptyTerritory = { slug: '', label: '', isOwned: false, monitoringEnabled: '', inheritAccountRules: true, guidance: '', tone: '', allowedThemes: '', disallowedThemes: '', escalationCues: '' };
const emptyDraft = { kind: 'publish_comment', itemId: '', territoryId: '', title: '', body: '', destination: 'item' };
const fieldClass = 'w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const buttonClass = 'rounded bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'rounded border border-port-border px-3 py-2 text-sm text-gray-200 disabled:opacity-50';
const splitList = (value) => value.split(',').map((entry) => entry.trim()).filter(Boolean);
const accountRules = (form) => ({ guidance: form.guidance, tone: form.tone, allowedThemes: splitList(form.allowedThemes), disallowedThemes: splitList(form.disallowedThemes), escalationCues: splitList(form.escalationCues), desiredEngagement: splitList(form.desiredEngagement), actionBudget: { maxPerHour: Number(form.maxPerHour), maxPerDay: Number(form.maxPerDay), minMinutesBetween: Number(form.minMinutesBetween) } });

export default function StackerNews() {
  const navigate = useNavigate();
  const { accountId } = useParams();
  const tab = useValidTab(TABS, 'review');
  const localModels = useLocalModels();
  const [accounts, setAccounts] = useState([]);
  const [territories, setTerritories] = useState([]);
  const [items, setItems] = useState([]);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newAccount, setNewAccount] = useState(emptyAccount);
  const [editAccount, setEditAccount] = useState(emptyAccount);
  const [newTerritory, setNewTerritory] = useState(emptyTerritory);
  const [draft, setDraft] = useState(emptyDraft);
  const [analysisResults, setAnalysisResults] = useState({});
  const [feedbackDrafts, setFeedbackDrafts] = useState({});

  const selected = accounts.find((account) => account.id === accountId) || null;
  const activeTab = selected ? tab : 'accounts';
  const accountPath = (id, nextTab = tab) => `/stacker-news/${id}/${nextTab}`;
  const models = useMemo(() => [...new Set(localModels.ollama)], [localModels.ollama]);

  const loadAccounts = useCallback(async () => {
    const result = await api.getStackerNewsAccounts({ silent: true }).catch((err) => ({ error: err.message }));
    if (result?.error) setError(result.error);
    else setAccounts(result?.accounts || []);
    setLoading(false);
  }, []);

  const loadSelected = useCallback(async () => {
    if (!accountId) {
      setTerritories([]); setItems([]); setActions([]);
      return;
    }
    const [territoryResult, itemResult, actionResult] = await Promise.all([
      api.getStackerNewsTerritories(accountId, { silent: true }).catch((err) => ({ error: err.message, territories: [] })),
      api.getStackerNewsItems(accountId, { silent: true }).catch((err) => ({ error: err.message, items: [] })),
      api.getStackerNewsActions(accountId, { silent: true }).catch((err) => ({ error: err.message, actions: [] })),
    ]);
    const failed = [territoryResult, itemResult, actionResult].find((result) => result.error);
    if (failed) setError(failed.error);
    setTerritories(territoryResult.territories || []);
    setItems(itemResult.items || []);
    setActions(actionResult.actions || []);
  }, [accountId]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadSelected(); }, [loadSelected]);
  useEffect(() => {
    if (!selected) return;
    setEditAccount({
      label: selected.label, username: selected.username, apiKey: '', enabled: selected.enabled,
      monitoringEnabled: selected.monitoringEnabled, monitoringIntervalMinutes: selected.monitoringIntervalMinutes,
      analysisEnabled: selected.analysisEnabled, textModel: selected.textModel, visionModel: selected.visionModel,
      guidance: selected.rules?.guidance || '', tone: selected.rules?.tone || '', allowedThemes: (selected.rules?.allowedThemes || []).join(', '),
      disallowedThemes: (selected.rules?.disallowedThemes || []).join(', '), escalationCues: (selected.rules?.escalationCues || []).join(', '),
      desiredEngagement: (selected.rules?.desiredEngagement || []).join(', '), maxPerHour: selected.rules?.actionBudget?.maxPerHour ?? 3,
      maxPerDay: selected.rules?.actionBudget?.maxPerDay ?? 12, minMinutesBetween: selected.rules?.actionBudget?.minMinutesBetween ?? 5,
    });
  }, [selected]);

  const finish = (key, promise, onSuccess) => {
    setBusy(key); setError(''); setNotice('');
    promise.then(onSuccess, (err) => setError(err.message)).finally(() => setBusy(''));
  };

  const createAccount = (event) => {
    event.preventDefault();
    finish('create-account', api.createStackerNewsAccount({
      label: newAccount.label, username: newAccount.username, enabled: newAccount.enabled, ...(newAccount.apiKey ? { apiKey: newAccount.apiKey } : {}),
      monitoringEnabled: newAccount.monitoringEnabled, monitoringIntervalMinutes: Number(newAccount.monitoringIntervalMinutes),
      analysisEnabled: newAccount.analysisEnabled, textModel: newAccount.textModel, visionModel: newAccount.visionModel,
      rules: accountRules(newAccount),
    }, { silent: true }), (result) => {
      setAccounts((previous) => [...previous, result]); setNewAccount(emptyAccount); navigate(accountPath(result.id, 'accounts'));
    });
  };

  const saveAccount = (event) => {
    event.preventDefault();
    if (!selected) return;
    finish('save-account', api.updateStackerNewsAccount(selected.id, {
      label: editAccount.label, username: editAccount.username, enabled: editAccount.enabled,
      ...(editAccount.apiKey ? { apiKey: editAccount.apiKey } : {}),
      monitoringEnabled: editAccount.monitoringEnabled, monitoringIntervalMinutes: Number(editAccount.monitoringIntervalMinutes),
      analysisEnabled: editAccount.analysisEnabled, textModel: editAccount.textModel, visionModel: editAccount.visionModel,
      rules: accountRules(editAccount),
    }, { silent: true }), (result) => {
      setAccounts((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
      setNotice('Account rules and schedule saved.');
    });
  };

  const createTerritory = (event) => {
    event.preventDefault();
    if (!selected) return;
    finish('create-territory', api.createStackerNewsTerritory({
      accountId: selected.id, slug: newTerritory.slug, label: newTerritory.label, isOwned: newTerritory.isOwned,
      monitoringEnabled: newTerritory.monitoringEnabled === '' ? null : newTerritory.monitoringEnabled === 'true',
      inheritAccountRules: newTerritory.inheritAccountRules, rules: {
        guidance: newTerritory.guidance, tone: newTerritory.tone, allowedThemes: splitList(newTerritory.allowedThemes),
        disallowedThemes: splitList(newTerritory.disallowedThemes), escalationCues: splitList(newTerritory.escalationCues),
      },
    }, { silent: true }), (result) => {
      setTerritories((previous) => [...previous, result]); setNewTerritory(emptyTerritory);
    });
  };

  const checkConnection = () => selected && finish('verify', api.verifyStackerNewsAccount(selected.id, { silent: true }), (result) => {
    setNotice(!result.connected ? 'Add an API key before testing.' : `API identity: @${result.username}. ${result.matchesConfigured ? 'Matches this account.' : 'Mismatch: writes are blocked.'}`);
  });
  const checkBrowser = () => selected && finish('browser', api.getStackerNewsBrowserIdentity(selected.id, { silent: true }), (result) => {
    setNotice(`Pinned browser identity: @${result.username || 'unknown'}. ${result.matchesConfigured ? 'Matches this account.' : 'Mismatch: handoffs are blocked.'}`);
  });
  const syncNow = () => selected && finish('sync', api.syncStackerNewsAccount(selected.id, { silent: true }), async (result) => {
    setNotice(`Sync complete: ${result.ingested} item(s), ${result.analyzed} analyzed.`); await Promise.all([loadAccounts(), loadSelected()]);
  });
  const analyze = (item) => finish(`analyze-${item.id}`, api.analyzeStackerNewsItem(item.id, { silent: true }), (result) => {
    setAnalysisResults((previous) => ({ ...previous, [item.id]: result }));
    setNotice(result.stale ? 'Content changed during analysis; the stale result cannot drive an action.' : `Policy decision: ${result.policy?.decision || 'review'}.`);
  });
  const saveFeedback = (item) => {
    const analysisId = analysisResults[item.id]?.analysisId;
    const feedback = feedbackDrafts[item.id]?.trim();
    if (!analysisId || !feedback) return;
    finish(`feedback-${item.id}`, api.addStackerNewsAnalysisFeedback(analysisId, feedback, { silent: true }), () => {
      setFeedbackDrafts((previous) => ({ ...previous, [item.id]: '' })); setNotice('Moderator feedback recorded with the policy version.');
    });
  };

  const createAction = (event) => {
    event.preventDefault();
    if (!selected) return;
    const isPost = draft.kind.endsWith('_post');
    const isComment = draft.kind.endsWith('_comment');
    const data = {
      accountId: selected.id,
      kind: draft.kind,
      ...(isPost || draft.destination === 'territory_settings' ? { territoryId: draft.territoryId } : {}),
      ...(isComment || draft.destination === 'item' ? { itemId: draft.itemId } : {}),
      ...(draft.kind === 'open_browser' ? { destination: draft.destination, payload: {} } : {}),
      ...(isPost ? { payload: { title: draft.title, body: draft.body } } : {}),
      ...(isComment ? { payload: { body: draft.body } } : {}),
    };
    finish('create-action', api.createStackerNewsAction(data, { silent: true }), (result) => {
      setActions((previous) => [result, ...previous]); setDraft(emptyDraft); navigate(accountPath(selected.id, 'review'));
    });
  };

  const reviewAction = (action, state) => finish(`review-${action.id}`, api.reviewStackerNewsAction(action.id, { state }, { silent: true }), (result) => {
    setActions((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
  });
  const executeAction = (action) => finish(`execute-${action.id}`, api.executeStackerNewsAction(action.id, { silent: true }), (result) => {
    setActions((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
    setNotice(result.state === 'completed' ? 'Reviewed action completed.' : `Action failed safely: ${result.error}`);
  });

  const renderReview = () => (
    <div className="grid gap-3 xl:grid-cols-2">
      <section className="rounded border border-port-border bg-port-card p-4">
        <h2 className="font-semibold text-white">Approval queue</h2>
        <p className="mt-1 text-sm text-gray-400">Approval and execution are separate. Identity, content freshness, rules, budgets, and idempotency are rechecked at execution.</p>
        <div className="mt-3 space-y-2">
          {actions.filter((action) => ['pending_review', 'approved'].includes(action.state)).map((action) => (
            <div key={action.id} className="rounded border border-port-border p-3 text-sm">
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-white">{action.kind.replaceAll('_', ' ')}</span><span className="text-xs text-gray-400">{action.state.replaceAll('_', ' ')}</span></div>
              <div className="mt-1 whitespace-pre-wrap text-gray-400">{action.payload?.title || action.payload?.body || `Fixed ${action.destination || 'local'} action`}</div>
              <div className="mt-1 font-mono text-[11px] text-gray-500">content {action.sourceContentHash?.slice(0, 10) || 'n/a'} · rules {action.rulesHash?.slice(0, 10) || 'n/a'} · {action.policyVersion}</div>
              {action.state === 'pending_review' && <div className="mt-2 flex gap-2"><button className={buttonClass} disabled={busy === `review-${action.id}`} onClick={() => reviewAction(action, 'approved')}>Approve</button><button className={secondaryButton} onClick={() => reviewAction(action, 'rejected')}>Reject</button></div>}
              {action.state === 'approved' && <button className={`${buttonClass} mt-2`} disabled={busy === `execute-${action.id}`} onClick={() => executeAction(action)}>Execute reviewed action</button>}
            </div>
          ))}
          {!actions.some((action) => ['pending_review', 'approved'].includes(action.state)) && <p className="text-sm text-gray-500">No actions are waiting.</p>}
        </div>
      </section>
      <section className="rounded border border-port-border bg-port-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold text-white">Monitored content</h2><p className="text-sm text-gray-400">Remote text and images remain untrusted data.</p></div><button className={secondaryButton} disabled={busy === 'sync'} onClick={syncNow}>Sync now</button></div>
        <div className="mt-3 space-y-2">{items.map((item) => <div key={item.id} className="rounded border border-port-border p-3"><div className="text-sm font-medium text-white">{item.title || `${item.kind} by @${item.authorName}`}</div><div className="mt-1 line-clamp-3 text-sm text-gray-400">{item.body}</div>{analysisResults[item.id] && <div className="mt-2 rounded bg-port-bg p-2 text-xs text-gray-300">Policy: {analysisResults[item.id].stale ? 'stale' : analysisResults[item.id].policy?.decision || 'review'}{analysisResults[item.id].policy?.reasons?.length ? ` · ${analysisResults[item.id].policy.reasons.join(', ')}` : ''}<div className="mt-2 flex gap-2"><input aria-label={`Feedback for ${item.title || item.id}`} className={fieldClass} placeholder="Moderator feedback" value={feedbackDrafts[item.id] || ''} onChange={(event) => setFeedbackDrafts((previous) => ({ ...previous, [item.id]: event.target.value }))} /><button className={secondaryButton} disabled={!analysisResults[item.id].analysisId || busy === `feedback-${item.id}`} onClick={() => saveFeedback(item)}>Save feedback</button></div></div>}<button className={`${secondaryButton} mt-2`} disabled={busy === `analyze-${item.id}`} onClick={() => analyze(item)}>Run local analysis</button></div>)}{!items.length && <p className="text-sm text-gray-500">No stored content. Add a territory, then sync explicitly or enable a schedule.</p>}</div>
      </section>
    </div>
  );

  const renderTerritory = () => (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Configured communities</h2><div className="mt-3 space-y-2">{territories.map((territory) => <div key={territory.id} className="rounded border border-port-border p-3"><div className="flex justify-between gap-2"><span className="font-medium text-white">{territory.label || territory.slug}</span><span className="text-xs text-gray-400">{territory.isOwned ? (territory.remoteSettings?.ownershipVerified ? 'Ownership verified' : 'Owned · not verified') : 'Monitored'}</span></div><p className="mt-1 text-sm text-gray-400">{territory.rules?.guidance || (territory.inheritAccountRules ? 'Inherits account rules.' : 'No custom guidance.')}</p><div className="mt-1 text-xs text-gray-500">Monitoring: {territory.monitoringEnabled == null ? 'inherit account' : territory.monitoringEnabled ? 'on' : 'off'}</div></div>)}{!territories.length && <p className="text-sm text-gray-500">Add communities this account monitors or owns.</p>}</div></section>
      <form className="rounded border border-port-border bg-port-card p-4" onSubmit={createTerritory}><h2 className="font-semibold text-white">Add community</h2><div className="mt-3 space-y-3"><Field id="territory-slug" label="Territory slug"><input id="territory-slug" required className={fieldClass} value={newTerritory.slug} onChange={(event) => setNewTerritory({ ...newTerritory, slug: event.target.value })} /></Field><Field id="territory-label" label="Local label"><input id="territory-label" className={fieldClass} value={newTerritory.label} onChange={(event) => setNewTerritory({ ...newTerritory, label: event.target.value })} /></Field><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={newTerritory.isOwned} onChange={(event) => setNewTerritory({ ...newTerritory, isOwned: event.target.checked })} /> This account owns this community</label><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={newTerritory.inheritAccountRules} onChange={(event) => setNewTerritory({ ...newTerritory, inheritAccountRules: event.target.checked })} /> Inherit account rules</label><Field id="territory-monitoring" label="Monitoring override"><select id="territory-monitoring" className={fieldClass} value={newTerritory.monitoringEnabled} onChange={(event) => setNewTerritory({ ...newTerritory, monitoringEnabled: event.target.value })}><option value="">Inherit account</option><option value="true">Enabled</option><option value="false">Disabled</option></select></Field><Field id="territory-rules" label="Territory guidance"><textarea id="territory-rules" className={fieldClass} rows="3" value={newTerritory.guidance} onChange={(event) => setNewTerritory({ ...newTerritory, guidance: event.target.value })} /></Field><Field id="territory-tone" label="Tone override"><input id="territory-tone" className={fieldClass} value={newTerritory.tone} onChange={(event) => setNewTerritory({ ...newTerritory, tone: event.target.value })} /></Field><Field id="territory-allowed" label="Allowed themes"><input id="territory-allowed" className={fieldClass} value={newTerritory.allowedThemes} onChange={(event) => setNewTerritory({ ...newTerritory, allowedThemes: event.target.value })} /></Field><Field id="territory-disallowed" label="Disallowed themes"><input id="territory-disallowed" className={fieldClass} value={newTerritory.disallowedThemes} onChange={(event) => setNewTerritory({ ...newTerritory, disallowedThemes: event.target.value })} /></Field><Field id="territory-escalation" label="Escalation cues"><input id="territory-escalation" className={fieldClass} value={newTerritory.escalationCues} onChange={(event) => setNewTerritory({ ...newTerritory, escalationCues: event.target.value })} /></Field><button className={buttonClass} disabled={busy === 'create-territory'}>Add community</button></div></form>
    </div>
  );

  const renderDrafts = () => {
    const post = draft.kind.endsWith('_post');
    const comment = draft.kind.endsWith('_comment');
    return <form className="mx-auto max-w-2xl rounded border border-port-border bg-port-card p-4" onSubmit={createAction}><h2 className="font-semibold text-white">Prepare a review-gated action</h2><p className="mt-1 text-sm text-gray-400">Wallet actions are browser handoffs only. Publishing uses the constrained API after separate approval.</p><div className="mt-3 space-y-3"><Field id="action-kind" label="Action"><select id="action-kind" className={fieldClass} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}><option value="draft_comment">Local comment draft</option><option value="publish_comment">Publish comment after review</option><option value="draft_post">Local post draft</option><option value="publish_post">Publish post after review</option><option value="open_browser">Open fixed browser handoff</option></select></Field>{draft.kind === 'open_browser' && <Field id="action-destination" label="Handoff"><select id="action-destination" className={fieldClass} value={draft.destination} onChange={(event) => setDraft({ ...draft, destination: event.target.value })}><option value="item">Item (zap, downzap, boost, or manual interaction)</option><option value="territory_settings">Territory settings</option></select></Field>}{(comment || (draft.kind === 'open_browser' && draft.destination === 'item')) && <Field id="action-item" label="Source item"><select id="action-item" required className={fieldClass} value={draft.itemId} onChange={(event) => setDraft({ ...draft, itemId: event.target.value })}><option value="">Choose item</option>{items.map((item) => <option key={item.id} value={item.id}>{item.title || `${item.kind} by ${item.authorName}`}</option>)}</select></Field>}{(post || (draft.kind === 'open_browser' && draft.destination === 'territory_settings')) && <Field id="action-territory" label="Territory"><select id="action-territory" required className={fieldClass} value={draft.territoryId} onChange={(event) => setDraft({ ...draft, territoryId: event.target.value })}><option value="">Choose territory</option>{territories.map((territory) => <option key={territory.id} value={territory.id}>{territory.label || territory.slug}</option>)}</select></Field>}{post && <Field id="action-title" label="Title"><input id="action-title" required className={fieldClass} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>}{(post || comment) && <Field id="action-body" label="Draft text"><textarea id="action-body" required className={fieldClass} rows="6" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} /></Field>}<button className={buttonClass} disabled={busy === 'create-action'}>Send to approval queue</button></div></form>;
  };

  const renderAccounts = () => (
    <div className="grid gap-3 xl:grid-cols-3">
      <section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Accounts</h2><div className="mt-3 space-y-2">{accounts.map((account) => <button key={account.id} className={`block w-full rounded border p-3 text-left ${account.id === selected?.id ? 'border-port-accent' : 'border-port-border'}`} onClick={() => navigate(accountPath(account.id, 'accounts'))}><div className="flex justify-between gap-2"><span className="font-medium text-white">{account.label}</span><span className="text-xs text-gray-400">{account.apiKeyConfigured ? 'Key protected' : 'No key'}</span></div><div className="mt-1 text-sm text-gray-400">@{account.username} · {account.monitoringEnabled ? `every ${account.monitoringIntervalMinutes}m` : 'monitoring off'}</div></button>)}{!accounts.length && <p className="text-sm text-gray-500">No accounts configured.</p>}</div></section>
      {selected ? <AccountForm title="Selected account" submitLabel="Save account" form={editAccount} setForm={setEditAccount} models={models} onSubmit={saveAccount} busy={busy === 'save-account'} extra={<div className="flex flex-wrap gap-2"><button type="button" className={secondaryButton} disabled={busy === 'verify'} onClick={checkConnection}>Check API identity</button><button type="button" className={secondaryButton} disabled={busy === 'browser'} onClick={checkBrowser}>Check browser identity</button><button type="button" className={secondaryButton} disabled={busy === 'sync'} onClick={syncNow}>Sync now</button></div>} /> : <div className="rounded border border-port-border bg-port-card p-4 text-sm text-gray-400">Choose an account to edit its independent rules, models, and monitoring schedule.</div>}
      <AccountForm title="Add account" submitLabel="Add protected account" form={newAccount} setForm={setNewAccount} models={models} onSubmit={createAccount} busy={busy === 'create-account'} showCredential />
    </div>
  );

  if (loading) return <PageSkeleton header="bar" label="Loading Stacker News" tabs={TABS.length} cards={3} />;
  const notFound = accountId && !selected;
  return <div className="flex h-full min-h-0 flex-col"><PageHeader icon={Newspaper} title="Stacker News" subtitle="Review-gated multi-account community stewardship" actions={selected && <span className="text-sm text-gray-400">@{selected.username}</span>} /><TabPills tabs={TABS} activeTab={activeTab} onChange={(nextTab) => selected ? navigate(accountPath(selected.id, nextTab)) : navigate('/stacker-news')} ariaLabel="Stacker News sections" /><main className="flex-1 overflow-auto p-4">{error && <div className="mb-3 rounded border border-port-error p-3 text-sm text-port-error">{error}</div>}{notice && <div className="mb-3 rounded border border-port-border p-3 text-sm text-gray-200">{notice}</div>}{notFound && <div className="mb-3 rounded border border-port-error p-4 text-sm text-port-error">This Stacker News account was not found. <button className="underline" onClick={() => navigate('/stacker-news')}>Return to accounts.</button></div>}{activeTab === 'review' && selected && renderReview()}{activeTab === 'territory' && selected && renderTerritory()}{activeTab === 'drafts' && selected && renderDrafts()}{activeTab === 'activity' && selected && <section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Action ledger</h2><div className="mt-3 space-y-2">{actions.map((action) => <div key={action.id} className="rounded border border-port-border p-3 text-sm text-gray-300"><div>{action.kind.replaceAll('_', ' ')} · {action.state}</div>{action.error && <div className="mt-1 text-port-error">{action.error}</div>}{action.result?.handoffOpened && <div className="mt-1 text-gray-400">Fixed browser handoff opened.</div>}</div>)}{!actions.length && <p className="text-sm text-gray-500">No actions recorded.</p>}</div></section>}{activeTab === 'accounts' && renderAccounts()}</main></div>;
}

function Field({ id, label, children }) {
  return <div><label htmlFor={id} className="mb-1 block text-sm text-gray-300">{label}</label>{children}</div>;
}

function AccountForm({ title, submitLabel, form, setForm, models, onSubmit, busy, showCredential = false, extra = null }) {
  const update = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  const prefix = showCredential ? 'new-account' : 'edit-account';
  return <form className="rounded border border-port-border bg-port-card p-4" onSubmit={onSubmit}><h2 className="font-semibold text-white">{title}</h2><p className="mt-1 text-sm text-gray-400">Credentials are encrypted separately and never sent to a model.</p><div className="mt-3 space-y-3"><Field id={`${prefix}-label`} label="Local label"><input id={`${prefix}-label`} required className={fieldClass} value={form.label} onChange={(event) => update('label', event.target.value)} /></Field><Field id={`${prefix}-username`} label="Stacker News username"><input id={`${prefix}-username`} required className={fieldClass} value={form.username} onChange={(event) => update('username', event.target.value)} /></Field><Field id={`${prefix}-api-key`} label={showCredential ? 'API key (optional)' : 'Replace API key (leave blank to keep)'}><input id={`${prefix}-api-key`} type="password" className={fieldClass} value={form.apiKey} onChange={(event) => update('apiKey', event.target.value)} /></Field><div className="grid grid-cols-2 gap-2"><Field id={`${prefix}-text-model`} label="Ollama text model"><ModelSelect id={`${prefix}-text-model`} value={form.textModel} models={models} onChange={(value) => update('textModel', value)} /></Field><Field id={`${prefix}-vision-model`} label="Ollama vision model"><ModelSelect id={`${prefix}-vision-model`} value={form.visionModel} models={models} onChange={(value) => update('visionModel', value)} /></Field></div><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} /> Account enabled</label><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={form.monitoringEnabled} onChange={(event) => update('monitoringEnabled', event.target.checked)} /> Enable scheduled monitoring</label><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={form.analysisEnabled} onChange={(event) => update('analysisEnabled', event.target.checked)} /> Run configured local analysis during monitoring</label><Field id={`${prefix}-interval`} label="Monitoring interval (minutes)"><input id={`${prefix}-interval`} type="number" min="5" max="1440" className={fieldClass} value={form.monitoringIntervalMinutes} onChange={(event) => update('monitoringIntervalMinutes', event.target.value)} /></Field><Field id={`${prefix}-guidance`} label="Stewardship guidance"><textarea id={`${prefix}-guidance`} className={fieldClass} rows="3" value={form.guidance} onChange={(event) => update('guidance', event.target.value)} /></Field><Field id={`${prefix}-tone`} label="Tone"><input id={`${prefix}-tone`} className={fieldClass} value={form.tone} onChange={(event) => update('tone', event.target.value)} /></Field><Field id={`${prefix}-allowed`} label="Allowed themes"><input id={`${prefix}-allowed`} className={fieldClass} value={form.allowedThemes} onChange={(event) => update('allowedThemes', event.target.value)} /></Field><Field id={`${prefix}-disallowed`} label="Disallowed themes"><input id={`${prefix}-disallowed`} className={fieldClass} value={form.disallowedThemes} onChange={(event) => update('disallowedThemes', event.target.value)} /></Field><Field id={`${prefix}-escalation`} label="Escalation cues"><input id={`${prefix}-escalation`} className={fieldClass} value={form.escalationCues} onChange={(event) => update('escalationCues', event.target.value)} /></Field><Field id={`${prefix}-engagement`} label="Desired engagement"><input id={`${prefix}-engagement`} className={fieldClass} value={form.desiredEngagement} onChange={(event) => update('desiredEngagement', event.target.value)} /></Field><div className="grid grid-cols-3 gap-2"><Field id={`${prefix}-hour-budget`} label="Max/hour"><input id={`${prefix}-hour-budget`} type="number" min="1" max="50" className={fieldClass} value={form.maxPerHour} onChange={(event) => update('maxPerHour', event.target.value)} /></Field><Field id={`${prefix}-day-budget`} label="Max/day"><input id={`${prefix}-day-budget`} type="number" min="1" max="200" className={fieldClass} value={form.maxPerDay} onChange={(event) => update('maxPerDay', event.target.value)} /></Field><Field id={`${prefix}-spacing`} label="Spacing min"><input id={`${prefix}-spacing`} type="number" min="0" max="1440" className={fieldClass} value={form.minMinutesBetween} onChange={(event) => update('minMinutesBetween', event.target.value)} /></Field></div>{extra}<button className={buttonClass} disabled={busy}>{submitLabel}</button></div></form>;
}

function ModelSelect({ id, value, models, onChange }) {
  return <select id={id} className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Disabled</option>{value && !models.includes(value) && <option value={value}>{value} (configured)</option>}{models.map((model) => <option key={model} value={model}>{model}</option>)}</select>;
}

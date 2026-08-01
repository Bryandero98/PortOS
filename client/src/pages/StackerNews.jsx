import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Newspaper, Plus, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
import * as api from '../services/api';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import { useValidTab } from '../hooks/useValidTab';

const TABS = [
  { id: 'review', label: 'Review', icon: ShieldCheck },
  { id: 'territory', label: 'Territory', icon: Newspaper },
  { id: 'drafts', label: 'Drafts', icon: Plus },
  { id: 'activity', label: 'Activity', icon: RefreshCw },
  { id: 'accounts', label: 'Accounts & Safety', icon: ShieldAlert },
];

const fieldClass = 'w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white';
const buttonClass = 'rounded bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50';

export default function StackerNews() {
  const navigate = useNavigate();
  const { accountId } = useParams();
  const tab = useValidTab(TABS, 'review');
  const [accounts, setAccounts] = useState([]);
  const [territories, setTerritories] = useState([]);
  const [items, setItems] = useState([]);
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newAccount, setNewAccount] = useState({ label: '', username: '', apiKey: '', textModel: '', visionModel: '', monitoringEnabled: false, rulesText: '' });
  const [newTerritory, setNewTerritory] = useState({ slug: '', label: '', isOwned: false, rulesText: '' });

  const selected = accounts.find((account) => account.id === accountId) || null;
  const accountPath = (id, nextTab = tab) => `/stacker-news/${id}/${nextTab}`;

  const loadAccounts = useCallback(async () => {
    const result = await api.getStackerNewsAccounts({ silent: true }).catch((err) => ({ error: err.message }));
    if (result?.error) setError(result.error);
    else setAccounts(result?.accounts || []);
    setLoading(false);
  }, []);

  const loadSelected = useCallback(async () => {
    if (!accountId) return;
    const [territoryResult, itemResult, actionResult] = await Promise.all([
      api.getStackerNewsTerritories(accountId, { silent: true }).catch(() => ({ territories: [] })),
      api.getStackerNewsItems(accountId, { silent: true }).catch(() => ({ items: [] })),
      api.getStackerNewsActions(accountId, { silent: true }).catch(() => ({ actions: [] })),
    ]);
    setTerritories(territoryResult.territories || []);
    setItems(itemResult.items || []);
    setActions(actionResult.actions || []);
  }, [accountId]);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  useEffect(() => { loadSelected(); }, [loadSelected]);

  const createAccount = async (event) => {
    event.preventDefault();
    setError('');
    const result = await api.createStackerNewsAccount({
      label: newAccount.label,
      username: newAccount.username,
      ...(newAccount.apiKey ? { apiKey: newAccount.apiKey } : {}),
      textModel: newAccount.textModel,
      visionModel: newAccount.visionModel,
      monitoringEnabled: newAccount.monitoringEnabled,
      rules: { guidance: newAccount.rulesText },
    }, { silent: true }).catch((err) => ({ error: err.message }));
    if (result.error) return setError(result.error);
    setAccounts((previous) => [...previous, result]);
    setNewAccount({ label: '', username: '', apiKey: '', textModel: '', visionModel: '', monitoringEnabled: false, rulesText: '' });
    navigate(accountPath(result.id, 'accounts'));
  };

  const createTerritory = async (event) => {
    event.preventDefault();
    if (!selected) return;
    setError('');
    const result = await api.createStackerNewsTerritory({
      accountId: selected.id, slug: newTerritory.slug, label: newTerritory.label,
      isOwned: newTerritory.isOwned, rules: { guidance: newTerritory.rulesText },
    }, { silent: true }).catch((err) => ({ error: err.message }));
    if (result.error) return setError(result.error);
    setTerritories((previous) => [...previous, result]);
    setNewTerritory({ slug: '', label: '', isOwned: false, rulesText: '' });
  };

  const verify = async () => {
    if (!selected) return;
    const result = await api.verifyStackerNewsAccount(selected.id, { silent: true }).catch((err) => ({ error: err.message }));
    setNotice(result.error ? `Connection check failed: ${result.error}` : result.connected ? `Connected as ${result.username || 'configured account'}.` : 'Add an API key before testing the connection.');
  };

  const reviewAction = async (action, state) => {
    const result = await api.reviewStackerNewsAction(action.id, { state }, { silent: true }).catch((err) => ({ error: err.message }));
    if (result.error) return setError(result.error);
    setActions((previous) => previous.map((candidate) => candidate.id === result.id ? result : candidate));
  };

  const renderReview = () => (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded border border-port-border bg-port-card p-4">
        <h2 className="font-semibold text-white">Pending approvals</h2>
        <p className="mt-1 text-sm text-gray-400">No model result can write externally. Every action remains pending review until you decide.</p>
        <div className="mt-3 space-y-2">
          {actions.filter((action) => action.state === 'pending_review').map((action) => (
            <div key={action.id} className="rounded border border-port-border p-3 text-sm">
              <div className="font-medium text-white">{action.kind.replaceAll('_', ' ')}</div>
              <div className="mt-1 text-gray-400">{action.payload?.text || 'Review the action payload in Activity before approval.'}</div>
              <div className="mt-2 flex gap-2"><button className={buttonClass} onClick={() => reviewAction(action, 'approved')}>Approve</button><button className="rounded border border-port-border px-3 py-2 text-sm text-gray-200" onClick={() => reviewAction(action, 'rejected')}>Reject</button></div>
            </div>
          ))}
          {!actions.some((action) => action.state === 'pending_review') && <p className="text-sm text-gray-500">No actions are waiting for review.</p>}
        </div>
      </section>
      <section className="rounded border border-port-border bg-port-card p-4">
        <h2 className="font-semibold text-white">Monitored content</h2>
        <p className="mt-1 text-sm text-gray-400">Text is treated as untrusted before deterministic screening or any optional local Ollama analysis.</p>
        <div className="mt-3 space-y-2">
          {items.map((item) => <div key={item.id} className="rounded border border-port-border p-3"><div className="text-sm font-medium text-white">{item.title || item.kind}</div><div className="mt-1 line-clamp-3 text-sm text-gray-400">{item.body}</div></div>)}
          {!items.length && <p className="text-sm text-gray-500">No content is stored yet. Monitoring is intentionally off until you enable it in account setup.</p>}
        </div>
      </section>
    </div>
  );

  const renderTerritory = () => (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Configured communities</h2><div className="mt-3 space-y-2">{territories.map((territory) => <div key={territory.id} className="rounded border border-port-border p-3"><div className="flex justify-between gap-2"><span className="font-medium text-white">{territory.label || territory.slug}</span>{territory.isOwned && <span className="text-xs text-port-accent">Owned</span>}</div><p className="mt-1 text-sm text-gray-400">{territory.rules?.guidance || 'No custom stewardship guidance.'}</p></div>)}{!territories.length && <p className="text-sm text-gray-500">Add the communities this account monitors or owns.</p>}</div></section>
      <form className="rounded border border-port-border bg-port-card p-4" onSubmit={createTerritory}><h2 className="font-semibold text-white">Add community</h2><div className="mt-3 space-y-3"><div><label htmlFor="territory-slug" className="mb-1 block text-sm text-gray-300">Territory slug</label><input id="territory-slug" required className={fieldClass} value={newTerritory.slug} onChange={(event) => setNewTerritory({ ...newTerritory, slug: event.target.value })} /></div><div><label htmlFor="territory-label" className="mb-1 block text-sm text-gray-300">Label</label><input id="territory-label" className={fieldClass} value={newTerritory.label} onChange={(event) => setNewTerritory({ ...newTerritory, label: event.target.value })} /></div><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={newTerritory.isOwned} onChange={(event) => setNewTerritory({ ...newTerritory, isOwned: event.target.checked })} /> This account owns this community</label><div><label htmlFor="territory-rules" className="mb-1 block text-sm text-gray-300">Stewardship guidance</label><textarea id="territory-rules" className={fieldClass} rows="4" value={newTerritory.rulesText} onChange={(event) => setNewTerritory({ ...newTerritory, rulesText: event.target.value })} /></div><button className={buttonClass}>Add community</button></div></form>
    </div>
  );

  const renderAccounts = () => (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Accounts</h2><div className="mt-3 space-y-2">{accounts.map((account) => <button key={account.id} className={`block w-full rounded border p-3 text-left ${account.id === selected?.id ? 'border-port-accent' : 'border-port-border'}`} onClick={() => navigate(accountPath(account.id, 'accounts'))}><div className="flex justify-between gap-2"><span className="font-medium text-white">{account.label}</span><span className="text-xs text-gray-400">{account.apiKeyConfigured ? 'API key protected' : 'No API key'}</span></div><div className="mt-1 text-sm text-gray-400">@{account.username} · monitoring {account.monitoringEnabled ? 'enabled' : 'off'}</div></button>)}</div>{selected && <div className="mt-4 rounded border border-port-border p-3"><div className="text-sm text-gray-300">Selected: @{selected.username}</div><button className={`${buttonClass} mt-2`} onClick={verify}>Test constrained API connection</button></div>}</section>
      <form className="rounded border border-port-border bg-port-card p-4" onSubmit={createAccount}><h2 className="font-semibold text-white">Add account</h2><p className="mt-1 text-sm text-gray-400">Credentials are encrypted at rest and never sent to a model.</p><div className="mt-3 space-y-3"><div><label htmlFor="account-label" className="mb-1 block text-sm text-gray-300">Local label</label><input id="account-label" required className={fieldClass} value={newAccount.label} onChange={(event) => setNewAccount({ ...newAccount, label: event.target.value })} /></div><div><label htmlFor="account-username" className="mb-1 block text-sm text-gray-300">Stacker News username</label><input id="account-username" required className={fieldClass} value={newAccount.username} onChange={(event) => setNewAccount({ ...newAccount, username: event.target.value })} /></div><div><label htmlFor="account-api-key" className="mb-1 block text-sm text-gray-300">API key (optional)</label><input id="account-api-key" type="password" className={fieldClass} value={newAccount.apiKey} onChange={(event) => setNewAccount({ ...newAccount, apiKey: event.target.value })} /></div><div><label htmlFor="account-text-model" className="mb-1 block text-sm text-gray-300">Local Ollama text model (optional)</label><input id="account-text-model" className={fieldClass} value={newAccount.textModel} onChange={(event) => setNewAccount({ ...newAccount, textModel: event.target.value })} /></div><div><label htmlFor="account-vision-model" className="mb-1 block text-sm text-gray-300">Local Ollama vision model (optional)</label><input id="account-vision-model" className={fieldClass} value={newAccount.visionModel} onChange={(event) => setNewAccount({ ...newAccount, visionModel: event.target.value })} /></div><label className="flex gap-2 text-sm text-gray-300"><input type="checkbox" checked={newAccount.monitoringEnabled} onChange={(event) => setNewAccount({ ...newAccount, monitoringEnabled: event.target.checked })} /> Enable monitoring after setup</label><div><label htmlFor="account-rules" className="mb-1 block text-sm text-gray-300">Account guidance</label><textarea id="account-rules" className={fieldClass} rows="3" value={newAccount.rulesText} onChange={(event) => setNewAccount({ ...newAccount, rulesText: event.target.value })} /></div><button className={buttonClass}>Add protected account</button></div></form>
    </div>
  );

  if (loading) return <PageSkeleton header="bar" label="Loading Stacker News" tabs={TABS.length} cards={3} />;
  return <div className="flex h-full min-h-0 flex-col"><PageHeader icon={Newspaper} title="Stacker News" subtitle="Review-gated community stewardship with local analysis" actions={selected && <span className="text-sm text-gray-400">@{selected.username}</span>} /><TabPills tabs={TABS} activeTab={tab} onChange={(nextTab) => selected ? navigate(accountPath(selected.id, nextTab)) : navigate('/stacker-news')} ariaLabel="Stacker News sections" /><main className="flex-1 overflow-auto p-4">{error && <div className="mb-3 rounded border border-port-error p-3 text-sm text-port-error">{error}</div>}{notice && <div className="mb-3 rounded border border-port-border p-3 text-sm text-gray-200">{notice}</div>}{!selected && tab !== 'accounts' && <div className="mb-3 rounded border border-port-border p-3 text-sm text-gray-400">Choose or add an account in Accounts & Safety before reviewing community activity.</div>}{tab === 'review' && selected && renderReview()}{tab === 'territory' && selected && renderTerritory()}{tab === 'drafts' && <div className="rounded border border-port-border bg-port-card p-4 text-sm text-gray-400">Draft actions are stored as pending review. Publishing remains disabled until a reviewed API capability is added.</div>}{tab === 'activity' && <div className="rounded border border-port-border bg-port-card p-4"><h2 className="font-semibold text-white">Action ledger</h2><div className="mt-3 space-y-2">{actions.map((action) => <div key={action.id} className="rounded border border-port-border p-3 text-sm text-gray-300">{action.kind.replaceAll('_', ' ')} · {action.state}</div>)}{!actions.length && <p className="text-sm text-gray-500">No actions recorded.</p>}</div></div>}{tab === 'accounts' && renderAccounts()}</main></div>;
}

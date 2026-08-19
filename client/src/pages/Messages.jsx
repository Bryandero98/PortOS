import { useNavigate, useParams } from 'react-router';
import { Mail, RefreshCw, Settings, MessageSquare, Users } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../services/api';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { useValidTab } from '../hooks/useValidTab';

import InboxTab from '../components/messages/InboxTab';
import ConfigTab from '../components/messages/ConfigTab';
import DraftsTab from '../components/messages/DraftsTab';
import SyncTab from '../components/messages/SyncTab';
import IMessageTab from '../components/messages/IMessageTab';
import ContactsTab from '../components/messages/ContactsTab';

// Exported for the nav-manifest tab-coverage guard (server/lib/navManifest.test.js).
// `fullBleed: true` — tab owns internal scroll/height; Messages skips padded overflow wrapper.
export const TABS = [
  { id: 'inbox', label: 'Inbox', icon: Mail },
  { id: 'drafts', label: 'Drafts', icon: Mail },
  { id: 'imessage', label: 'iMessage', icon: MessageSquare, fullBleed: true },
  { id: 'contacts', label: 'Contacts', icon: Users },
  { id: 'sync', label: 'Sync', icon: RefreshCw },
  { id: 'config', label: 'Config', icon: Settings },
];

const FULL_BLEED_TAB_IDS = new Set(TABS.filter((t) => t.fullBleed).map((t) => t.id));

// Tabs that render the account list wait for it. iMessage and Contacts read
// neither — gating them on the accounts fetch would serialize their own
// requests behind an unrelated one and flash a skeleton for no reason.
const ACCOUNT_TAB_IDS = new Set(['inbox', 'drafts', 'sync', 'config']);

export default function Messages() {
  const navigate = useNavigate();
  const { chatKey } = useParams();
  const activeTab = useValidTab(TABS, 'inbox');
  const fullBleed = FULL_BLEED_TAB_IDS.has(activeTab);
  // `null` = the account list never loaded (request failed) — deliberately distinct
  // from `[]`, which means "loaded, and there genuinely are no accounts". The inbox
  // empty state branches on that difference to avoid telling a user to add an
  // account they already have (#3281).
  const [accounts, setAccounts] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    const data = await api.getMessageAccounts().catch(() => null);
    setAccounts(Array.isArray(data) ? data : null);
    setLoading(false);
  }, []);

  // Tabs that only iterate accounts want a plain array; the load-failed sentinel
  // is forwarded to the inbox alone, which is the one surface that acts on it.
  const accountList = accounts || [];

  // ConfigTab mutates the list with functional updaters — normalize the sentinel
  // so `prev` is always an array there.
  const updateAccounts = useCallback((updater) => {
    setAccounts(prev => (typeof updater === 'function' ? updater(prev || []) : updater));
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Deep-link cleanup: only the imessage tab uses :chatKey. Drop a stale second
  // segment if the user lands on e.g. /messages/inbox/<something>.
  useEffect(() => {
    if (chatKey && activeTab !== 'imessage') {
      navigate(`/messages/${activeTab}`, { replace: true });
    }
  }, [chatKey, activeTab, navigate]);

  const handleTabChange = (tabId) => {
    navigate(`/messages/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'inbox':
        return <InboxTab accounts={accounts} />;
      case 'config':
        return <ConfigTab accounts={accountList} setAccounts={updateAccounts} />;
      case 'drafts':
        return <DraftsTab accounts={accountList} />;
      case 'sync':
        return <SyncTab accounts={accountList} onRefresh={fetchAccounts} />;
      case 'imessage':
        return <IMessageTab />;
      case 'contacts':
        return <ContactsTab />;
      default:
        return <InboxTab accounts={accounts} />;
    }
  };

  if (loading && ACCOUNT_TAB_IDS.has(activeTab)) {
    return (
      <PageSkeleton
        header="bar"
        label="Loading messages"
        fullHeight
        // Full-bleed tabs (iMessage) render edge to edge — no body padding.
        padded={!fullBleed}
        bodyClassName="p-4"
        titleWidthClass="w-36"
        showSubtitle
        tabs={TABS.length}
        cards={3}
        sidebar={false}
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={Mail}
        title="Messages"
        subtitle="Unified email and messaging management"
        actions={loading ? null : (
          <span className="text-sm text-gray-500">
            {accounts === null ? 'Accounts unavailable' : `${accounts.length} accounts`}
          </span>
        )}
      />

      <TabPills tabs={TABS} activeTab={activeTab} onChange={handleTabChange} ariaLabel="Messages sections" />

      <div className={`flex-1 min-h-0 ${fullBleed ? 'overflow-hidden' : 'overflow-auto p-4'}`}>
        {renderTabContent()}
      </div>
    </div>
  );
}

import { useParams, Navigate } from 'react-router';
import { Cpu } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import ModelsTabsHeader from '../components/models/ModelsTabsHeader';
import MemoryManagement from '../components/settings/MemoryManagement.jsx';
import LocalModelAssessments from '../components/settings/LocalModelAssessments.jsx';
import { LocalLlmTab } from '../components/settings/LocalLlmTab';

/**
 * Models — the top-level home for everything about the models this machine runs.
 *
 * Three tabs, each of which was previously a card buried in
 * `/settings/local-llm`:
 *
 *   - **LLMs** — backends, the install catalog, the llama.cpp launcher.
 *   - **Performance** — measured assessments and launch-tuning comparison.
 *   - **Status** — what is resident in memory right now.
 *
 * `?tab` is a route param, not local state, so every one is deep-linkable and
 * reachable from ⌘K and voice (`client/src/CLAUDE.md`).
 *
 * Only LLM model management lives here so far. Media models (LoRAs, image/video
 * checkpoints, embeddings) are tracked for the same treatment in #4728; the
 * design record is `docs/plans/2026-08-21-models-navigation.md`.
 */
const TAB_CONTENT = {
  llms: LocalLlmTab,
  performance: LocalModelAssessments,
  status: MemoryManagement,
};

export default function Models() {
  const { tab } = useParams();
  // An unknown slug lands on Performance rather than rendering a blank page —
  // it is the tab that answers "which model should I use?", which is what most
  // people arrive here for.
  const activeTab = tab && TAB_CONTENT[tab] ? tab : null;
  if (!activeTab) return <Navigate to="/models/performance" replace />;

  const TabContent = TAB_CONTENT[activeTab];

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <PageHeader icon={Cpu} title="Models" />

      <ModelsTabsHeader activeTab={activeTab} />

      <div className="flex-1 min-w-0 overflow-auto p-4">
        <TabContent />
      </div>
    </div>
  );
}

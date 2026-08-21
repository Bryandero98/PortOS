import { useParams, Navigate } from 'react-router';
import { Cpu } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import ModelsTabsHeader from '../components/models/ModelsTabsHeader';
import Image3dRuntimes from '../components/models/Image3dRuntimes';
import ModelStatusTab from '../components/models/ModelStatusTab';
import EmbeddingsTab from '../components/settings/EmbeddingsTab';
import LocalModelAssessments from '../components/settings/LocalModelAssessments.jsx';
import { LocalLlmTab } from '../components/settings/LocalLlmTab';
import Loras from './Loras';
import LoraTraining from './LoraTraining';
import MediaModels from './MediaModels';

/**
 * Models — the top-level home for everything about the models this machine runs.
 *
 * The section started as three tabs carved out of `/settings/local-llm`, and now
 * covers every KIND of model an install manages (#4728), not just text:
 *
 *   - **3D** — image-to-3D runtime install/repair (TRELLIS.2, Pixal3D).
 *   - **Embeddings** — the embedding model backing pgvector search.
 *   - **LLMs** — backends, the install catalog, the llama.cpp launcher.
 *   - **LoRAs** — installed image/video adapters.
 *   - **Media** — image/video checkpoints and the Hugging Face cache.
 *   - **Performance** — measured assessments and launch-tuning comparison.
 *   - **Status** — residency plus the downloaded-model inventory.
 *   - **Training** — LoRA fine-tuning datasets and runs.
 *
 * What deliberately stayed OUT is output rather than weights: Three.js Models is
 * a gallery of generated meshes, and `/3d` is the render flow that consumes the
 * runtimes listed here. Audio models stayed in the Music studio too — their
 * picker is not separable from the generate form. Design record:
 * `docs/plans/2026-08-21-models-navigation.md`.
 *
 * `?tab` is a route param, not local state, so every one is deep-linkable and
 * reachable from ⌘K and voice (`client/src/CLAUDE.md`).
 */
const TAB_CONTENT = {
  '3d': Image3dRuntimes,
  embeddings: EmbeddingsTab,
  llms: LocalLlmTab,
  loras: Loras,
  media: MediaModels,
  performance: LocalModelAssessments,
  status: ModelStatusTab,
  training: LoraTraining,
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

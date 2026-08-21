import ModelsPanel from './ModelsPanel.jsx';
import { useSystemResourceReport } from '../../hooks/useSystemResourceReport.js';

/**
 * Models → Status: what is resident right now, plus what is on disk.
 *
 * Residency (`MemoryManagement`) and the downloaded-model inventory used to be
 * two pages in two sections — `/models/status` and Dev Tools'
 * `/system-resources/models` — answering the same question ("what models does
 * this machine have, and what is loaded?") in different places. `ModelsPanel`
 * already rendered residency above the inventory, so folding them is a matter of
 * hosting that panel here and feeding it the shared scan (#4728).
 *
 * The scan is deliberately NOT run on mount: it walks the Hugging Face cache,
 * `data/loras/`, Ollama and LM Studio, which is slow and pointless for a user who
 * came here to unload a model. `ModelsPanel` shows its own "Run model inventory"
 * prompt until the user asks.
 */
export default function ModelStatusTab() {
  const { report, loading, runReport, cleanup } = useSystemResourceReport();

  return (
    <ModelsPanel
      report={report}
      loading={loading}
      onRunReport={runReport}
      cleanup={cleanup}
    />
  );
}

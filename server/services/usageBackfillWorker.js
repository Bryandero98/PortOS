import { isMainThread, parentPort, workerData } from 'worker_threads';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { estimateTokens, estimateTokensFromChars } from '../lib/contextBudget.js';
import { readJSONFile, tryReadFile } from '../lib/fileUtils.js';
import { reconcileRunUsage, transcriptFamily } from './usageReconciler.js';

const listRunIds = async (runsDir) => readdir(runsDir, { withFileTypes: true })
  .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  .catch(() => []);

const isMeasured = (record) => (Array.isArray(record) ? record : [record])
  .some((entry) => entry?.source === 'measured');

/**
 * Read historical run artifacts and produce estimate→measurement corrections.
 * This function runs inside a worker in production so parsing large JSONL files
 * never blocks the server event loop; it is exported for fixture-based tests.
 */
export async function scanHistoricalUsage({
  runsDir,
  home,
  reconciledRunIds = [],
  onProgress = () => {}
}) {
  const reconciled = new Set(reconciledRunIds);
  const candidates = [];

  for (const runId of await listRunIds(runsDir)) {
    if (reconciled.has(runId)) continue;
    const metadataPath = join(runsDir, runId, 'metadata.json');
    const metadata = await readJSONFile(metadataPath, null);
    if (!metadata || metadata.usageReconciled || !metadata.providerId || !metadata.workspacePath
      || typeof metadata.startTime !== 'string' || typeof metadata.endTime !== 'string'
      || !Number.isFinite(Date.parse(metadata.startTime)) || !Number.isFinite(Date.parse(metadata.endTime))
      || !transcriptFamily(metadata)) continue;
    candidates.push({ runId, metadataPath, metadata });
  }
  candidates.sort((a, b) => Date.parse(a.metadata.startTime) - Date.parse(b.metadata.startTime));

  const corrections = [];
  let processed = 0;
  onProgress({ processed, total: candidates.length, found: corrections.length });
  for (const candidate of candidates) {
    const output = await tryReadFile(join(runsDir, candidate.runId, 'output.txt'));
    const estimate = {
      messages: 1,
      tokensIn: estimateTokensFromChars(candidate.metadata.promptLength),
      tokensOut: estimateTokens(output || ''),
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    };
    const measured = await reconcileRunUsage(candidate.metadata, estimate, { home });
    if (isMeasured(measured)) {
      corrections.push({
        runId: candidate.runId,
        metadataPath: candidate.metadataPath,
        day: candidate.metadata.endTime.slice(0, 10),
        providerId: candidate.metadata.providerId,
        model: candidate.metadata.model ?? null,
        estimate,
        measured
      });
    }
    processed++;
    onProgress({ processed, total: candidates.length, found: corrections.length });
  }

  return { corrections, processed, total: candidates.length };
}

if (!isMainThread) {
  scanHistoricalUsage({
    ...workerData,
    onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
  })
    .then((result) => parentPort.postMessage({ type: 'complete', result }))
    .catch((error) => parentPort.postMessage({ type: 'error', error: error.message }));
}

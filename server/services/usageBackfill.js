import { Worker } from 'worker_threads';
import { homedir } from 'os';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import {
  applyHistoricalUsageCorrections,
  getReconciledUsageRunIds
} from './usage.js';
import { mergeUsageClaims, snapshotUsageClaims } from './usageReconciler.js';

let job = {
  status: 'idle',
  processed: 0,
  total: 0,
  found: 0,
  corrected: 0,
  error: null,
  startedAt: null,
  completedAt: null
};

const publicJob = () => ({ ...job });

const markRunMetadata = async (corrections) => {
  for (const correction of corrections) {
    const metadata = await readJSONFile(correction.metadataPath, null);
    if (!metadata) continue;
    metadata.usageReconciled = true;
    metadata.usageReconciledAt = new Date().toISOString();
    await atomicWrite(correction.metadataPath, metadata);
  }
};

export function getHistoricalUsageBackfillStatus() {
  return publicJob();
}

/**
 * Start the one-shot historical repair. The explicit POST route is the only
 * caller; no boot hook or schedule invokes this function.
 */
export function startHistoricalUsageBackfill({
  runsDir = PATHS.runs,
  home = homedir(),
  WorkerClass = Worker
} = {}) {
  if (job.status === 'running') return publicJob();

  job = {
    status: 'running',
    processed: 0,
    total: 0,
    found: 0,
    corrected: 0,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  const worker = new WorkerClass(new URL('./usageBackfillWorker.js', import.meta.url), {
    workerData: {
      runsDir,
      home,
      reconciledRunIds: getReconciledUsageRunIds(),
      // The worker gets its own empty copy of usageReconciler.js's claim
      // ledger (a separate module instance) — seed it from this thread's
      // ledger so a message the live completion path already billed isn't
      // billed again by the backfill scan.
      claimsSeed: snapshotUsageClaims()
    }
  });

  let messageTail = Promise.resolve();
  worker.on('message', (message) => {
    messageTail = messageTail.then(async () => {
      if (message?.type === 'progress') {
        job = { ...job, ...message.progress };
        return;
      }
      if (message?.type === 'error') {
        job = { ...job, status: 'error', error: message.error || 'Backfill failed', completedAt: new Date().toISOString() };
        return;
      }
      if (message?.type !== 'complete') return;
      const result = message.result || {};
      if (result.claimsSnapshot) mergeUsageClaims(result.claimsSnapshot);
      const applied = await applyHistoricalUsageCorrections(result.corrections || []);
      const appliedCorrections = (result.corrections || [])
        .filter((correction) => applied.correctedRunIds.includes(correction.runId));
      await markRunMetadata(appliedCorrections);
      job = {
        ...job,
        status: 'complete',
        processed: result.processed || 0,
        total: result.total || 0,
        found: result.corrections?.length || 0,
        corrected: applied.corrected,
        completedAt: new Date().toISOString()
      };
    }).catch((error) => {
      job = { ...job, status: 'error', error: error.message, completedAt: new Date().toISOString() };
    });
  });
  worker.on('error', (error) => {
    job = { ...job, status: 'error', error: error.message, completedAt: new Date().toISOString() };
  });
  worker.unref();
  return publicJob();
}

export function __resetHistoricalUsageBackfillForTests() {
  job = {
    status: 'idle',
    processed: 0,
    total: 0,
    found: 0,
    corrected: 0,
    error: null,
    startedAt: null,
    completedAt: null
  };
}

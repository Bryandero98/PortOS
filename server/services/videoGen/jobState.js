/**
 * Shared mutable state for the single local-video lane.
 *
 * Generation, chained orchestration, and SSE attachment live in separate
 * modules but deliberately coordinate through this one process-local record.
 */

import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { attachSseClient as attachSse } from '../../lib/sseUtils.js';

export const videoJobState = {
  jobs: new Map(),
  activeProcess: null,
  cancelEpoch: 0,
  activeChain: null,
};

export const attachSseClient = (jobId, res) => attachSse(videoJobState.jobs, jobId, res);

export const cancel = () => {
  videoJobState.cancelEpoch += 1;
  // Flag a chain so its orchestrator stops between chunks, then terminate the
  // child currently holding the local GPU lane when one exists.
  if (videoJobState.activeChain) videoJobState.activeChain.stopped = true;
  if (!videoJobState.activeProcess) return !!videoJobState.activeChain;
  const proc = videoJobState.activeProcess;
  // Keep the handle until close so a new render cannot replace it before the
  // escalation timer has had a chance to SIGKILL a stubborn child.
  killWithEscalation(proc, {
    label: 'video child',
    stillRunning: () => videoJobState.activeProcess === proc,
  });
  return true;
};

import { useCallback } from 'react';
import { buildVideoGenSubmission, envelopVideoPrompt } from '../lib/videoGenSubmission.js';

/** Keeps request shaping behind one focused boundary for every VideoGen lane. */
export function useVideoGenSubmitFlow(submissionState) {
  const buildGeneratePayload = useCallback(
    () => buildVideoGenSubmission(submissionState),
    [submissionState],
  );

  return {
    buildGeneratePayload,
    envelopedPrompt: envelopVideoPrompt(submissionState.prompt, submissionState),
  };
}

export default useVideoGenSubmitFlow;

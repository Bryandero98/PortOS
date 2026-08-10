import { useCallback, useEffect, useState } from 'react';
import useAsyncAction from './useAsyncAction.js';
import { getVideoModelTerms, setVideoModelTerms } from '../services/apiImageVideo.js';

/**
 * Install-wide acknowledgement of restricted video-model license gates
 * (`model.termsGate`), persisted in settings rather than in this browser.
 *
 * One person operates a PortOS install, and they reach the same restricted
 * model from several surfaces — the Video Gen page, a music video board, a
 * pipeline stage, an agent run. Acceptance therefore belongs to the install:
 * accepting once here authorizes every render path, and the server enforces
 * the same exact versioned id it stores (a revised license fails closed).
 *
 * `accepted` is `null` until the list is fetched — distinct from `[]`
 * ("fetched, nothing accepted") so a surface can tell "still loading" from
 * "genuinely unaccepted". A failed fetch also leaves it null, and `isAccepted`
 * stays false either way, so the gate fails closed and the user gets the
 * acceptance UI instead of a dead end.
 */
export default function useVideoModelTerms() {
  const [accepted, setAccepted] = useState(null);

  const refresh = useCallback(() => getVideoModelTerms({ silent: true })
    .then((res) => setAccepted(Array.isArray(res?.accepted) ? res.accepted : []))
    .catch(() => {}), []);

  useEffect(() => { refresh(); }, [refresh]);

  const isAccepted = useCallback(
    (termsId) => !!termsId && Array.isArray(accepted) && accepted.includes(termsId),
    [accepted],
  );

  const [writeAcceptance, saving] = useAsyncAction(
    (termsId, value) => setVideoModelTerms(termsId, value, { silent: true })
      .then((res) => setAccepted(Array.isArray(res?.accepted) ? res.accepted : [])),
    { errorMessage: 'Failed to save model terms acceptance' },
  );

  // Resolves to whether the write landed, so a caller can chain a retry of the
  // render the user was blocked on. useAsyncAction resolves to null when the
  // request throws (having already toasted it).
  const setAcceptance = (termsId, value) => (termsId
    ? writeAcceptance(termsId, value).then((result) => result !== null)
    : Promise.resolve(false));

  return { accepted, loaded: accepted !== null, saving, isAccepted, setAcceptance, refresh };
}

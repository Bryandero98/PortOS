import { useEffect, useState } from 'react';
import * as api from '../services/api';

// Sentinel shape while the lookup is in flight or has failed. `reviewers: null`
// is deliberately NOT `[]` — an empty array is a real answer ("this app resolves
// to no reviewers") and a caller that seeds a picker from it would render an
// empty chain as though it were configured. Callers gate on `resolved`.
const PENDING = Object.freeze({
  resolved: false,
  source: null,
  reviewers: null,
  usernames: [],
  optionalReviewers: [],
  reviewerMaxRounds: {},
  reviewerModels: {},
  reviewerEfforts: {},
  csv: ''
});

/**
 * The reviewers a `/do:next` claim will ACTUALLY run for `appId`.
 *
 * Distinct from `useCodeReviewDefaults`, and the distinction is the whole point:
 * the defaults hook reads Models → Code Reviewers, while a claim resolves its
 * reviewers as claim-work task metadata FIRST and only falls back to those
 * defaults. A `claim-work` reviewer override therefore runs a chain the defaults
 * hook cannot see — which is how a claim launched from the Issues tab came to
 * review with `codex` while every reviewer control on screen showed
 * `antigravity`. Seed claim surfaces from here; `source` says which layer won.
 *
 * A failed lookup stays `resolved: false` rather than reporting an empty chain —
 * "couldn't ask" and "nothing configured" must not collapse. Fetches once per
 * mount; a claim drawer is mounted only while open, which is the refresh.
 */
export default function useClaimReviewers(appId) {
  const [value, setValue] = useState(PENDING);

  useEffect(() => {
    if (!appId) {
      setValue(PENDING);
      return undefined;
    }
    let cancelled = false;
    setValue(PENDING);
    api.getAppClaimReviewers(appId)
      .then((data) => {
        if (cancelled || !Array.isArray(data?.reviewers)) return;
        setValue({
          resolved: true,
          source: data.source || null,
          reviewers: data.reviewers,
          usernames: Array.isArray(data.usernames) ? data.usernames : [],
          optionalReviewers: Array.isArray(data.optionalReviewers) ? data.optionalReviewers : [],
          reviewerMaxRounds: data.reviewerMaxRounds || {},
          reviewerModels: data.reviewerModels || {},
          reviewerEfforts: data.reviewerEfforts || {},
          csv: data.csv || ''
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [appId]);

  return value;
}

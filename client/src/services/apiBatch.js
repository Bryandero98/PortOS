import { request } from './apiCore.js';

/**
 * Batch-fetch records by id through a list route's `?ids=a,b,c` filter (#4148) —
 * the client half of the server's shared `csvIdsParam` query param.
 *
 * De-dupes and drops falsy ids, then unwraps a paginated `{ items }` envelope to
 * a plain array. Ids the server omits (missing or soft-deleted) are simply
 * absent from the result, so callers index it by `id` rather than assuming
 * positional parity with the request.
 *
 * The empty-list short-circuit is load-bearing, not a micro-optimization: a
 * present-but-blank `?ids=` reads as ABSENT server-side, so issuing the request
 * anyway would return the whole unfiltered list — the exact over-fetch these
 * batch helpers exist to remove.
 *
 * Lives in its own module rather than inside `apiCore.js` so the suites that
 * mock `./apiCore.js` wholesale still intercept the `request` this makes.
 */
export async function fetchByIds(path, ids = [], options) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  if (list.length === 0) return [];
  const params = new URLSearchParams({ ids: list.join(',') });
  const res = await request(`${path}?${params}`, options);
  return Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
}

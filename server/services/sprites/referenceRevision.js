/**
 * Coordinate a directional-reference revision with its dependent walk.
 *
 * Reference state owns whether the anchor can be reopened; walk state owns the
 * approval that may have been conditioned on the old image. Keeping the
 * cross-service sequence here leaves the HTTP route declarative.
 */

import { assertReferenceAnchorUnlockable, unlockReferenceAnchor } from './reference.js';
import { invalidateWalkDirectionForAnchorRevision } from './walk.js';

export async function unlockDirectionalAnchor(recordId, { direction }) {
  // Preflight before touching the dependent selection, then remove the stale
  // approval before clearing the anchor pointer. If the second write ever
  // fails, the safe partial state has no approved walk claiming a stale source;
  // rendered runs and the old locked anchor file both remain recoverable.
  await assertReferenceAnchorUnlockable(recordId, { direction });
  const walkInvalidated = await invalidateWalkDirectionForAnchorRevision(recordId, { direction });
  const reference = await unlockReferenceAnchor(recordId, { direction });
  return { ...reference, walkInvalidated };
}

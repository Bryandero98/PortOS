/**
 * Teach the foundation judge which persisted surface owns each repair.
 *
 * A judge could correctly spot a plot synopsis violating a clear world rule,
 * but label it worldbuilding and ask that repair to revise the episode. The
 * world editor can only update the universe bible, so the causal contradiction
 * survived every round. The ownership contract routes plot applications to
 * structure while keeping missing rules in worldbuilding. Hash replacement
 * preserves customized prompts and is idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-judge-foundation.md': ['74c0244e641dcf7a73e9c83123ebdee9'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-judge-foundation.md': '4c0bd349ff4d329048c9f4ac068745d4',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'foundation judge repair ownership',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the repair ownership boundaries.`,
});

export { applyMigration };
export default { up };

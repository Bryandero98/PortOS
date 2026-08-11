/**
 * Make the protected Universe Builder starter idea part of foundation quality.
 *
 * The judge previously saw only generated world fields. It could therefore
 * approve a coherent replacement premise that contradicted the user's
 * originating concept, then cache that verdict because starterPrompt was not
 * in the input hash. The service now renders and hashes starterPrompt; this
 * prompt change tells the independent judge how to treat that evidence.
 * Hash replacement preserves customized prompts and is idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-judge-foundation.md': ['4c0bd349ff4d329048c9f4ac068745d4'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-judge-foundation.md': 'edf7850d0c724c63761bc9fb667227d9',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'foundation judge protected author intent',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the protected-author-intent rule.`,
});

export { applyMigration };
export default { up };

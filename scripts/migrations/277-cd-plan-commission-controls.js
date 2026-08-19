/**
 * Keep Creative Commission planning anchored to the user's selected output and
 * model capabilities. Hash replacement preserves customized stage prompts.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'cd-plan.md': ['ef0d96f6ebde43af6c4579969d31cfb7'],
};

export const NEW_SHIPPED_MD5 = {
  'cd-plan.md': '41a61590896d1327df2c6915557361de',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'Creative Director commission controls',
  customizedHint: () =>
    '   Compare data.reference/prompts/stages/cd-plan.md with data/prompts/stages/cd-plan.md and merge the commission/model-control guidance.',
});

export { applyMigration };
export default { up };

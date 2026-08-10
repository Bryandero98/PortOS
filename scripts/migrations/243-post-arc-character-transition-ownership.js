/**
 * Keep post-arc character repair from inventing unstaged plot events.
 *
 * The character editor may deepen a planned person's motivation and ending,
 * but episode-numbered transition beats belong to the structure editor once a
 * macro arc exists. Hash replacement upgrades only the prior shipped prompt;
 * customized installs remain untouched and receive a manual-upgrade hint.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-character-foundation.md': ['cda34127b40754ddbcc8544e3d82572b'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-character-foundation.md': 'd6c449c06de73a0868141c899b26e52c',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'post-arc character transition ownership',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and keep transition beats read-only\n` +
    '   during post-arc character reconciliation.',
});

export { applyMigration };
export default { up };

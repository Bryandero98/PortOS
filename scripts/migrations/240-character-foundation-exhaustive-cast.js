/**
 * Upgrade the character-foundation prompt from a single implicit core-cast
 * array to an explicit target batch plus the full series ensemble map.
 *
 * The server now processes every story-referenced character in sequential
 * batches. Existing installs need this prompt wording so the model authors the
 * whole target batch while using the full roster for differentiation. The
 * hash-driven replacement preserves customized prompts and is idempotent.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-character-foundation.md': ['f1c0b75a8161c0bc7f26752d148a5c1c'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-character-foundation.md': 'cda34127b40754ddbcc8544e3d82572b',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'exhaustive series-cast character foundation',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and adopt the targetCharacters\n` +
    '   plus fullSeriesRoster workset contract.',
});

export { applyMigration };
export default { up };

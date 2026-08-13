/**
 * Teach the two pipeline-diagnosis prompts to read a resolver attempt's outcome.
 *
 * The arc gate now emits one retained frame per resolver call (`resolve:round`
 * for an attempt that wrote something, `resolve:no-change` for one that did
 * not), carrying per-record mutation counts and a categorical `noChangeReason`.
 * Without this legend the diagnosis keeps making the two misreadings the frames
 * were added to prevent: treating `episodesEdited: 0` as "the resolver did
 * nothing" — it is the EXPECTED report at the arc-spine altitude, whose resolver
 * may only patch the arc and volumes — and treating a stall as one undifferentiated
 * failure when the reason separates a rejected exact-text patch from an
 * out-of-scope answer from an honest content-level refusal.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'pipeline-observer.md': ['f3dc51ac077050a887c2161ee7438181'],
  'pipeline-self-improve.md': ['ed0b0df42e0690d515b8dd88911931e4'],
};

export const NEW_SHIPPED_MD5 = {
  'pipeline-observer.md': '29e0212d2252b1be3278f20e2959eb8e',
  'pipeline-self-improve.md': '95b378832ff78e5976a6a63fcf328090',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'resolve-outcome telemetry legend',
  customizedHint: (filename) =>
    `   To upgrade it manually, diff data.reference/prompts/stages/${filename}\n` +
    `   against data/prompts/stages/${filename} and add the resolve:round /\n` +
    `   resolve:no-change bullet describing the per-record mutation counts and\n` +
    `   the noChangeReason values.`,
});

export { applyMigration };
export default { up };

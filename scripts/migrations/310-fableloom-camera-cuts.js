/**
 * Upgrade FableLoom generation/editing prompts to one renderable camera cut
 * per node and add the shared camera-movement vocabulary.
 */

import { makePromptReplaceMigration } from './_lib.js';

export const ACCEPTED_OLD_MD5 = {
  'fableloom-weave-episode.md': ['1b27f5b0073a304c21079aa6e2c71447'],
  'fableloom-branch-node.md': ['6279b1c9912c300363a727245d22fe84'],
  'fableloom-feedback-episode.md': ['43d1525fcedce99b933ae5b003516a36'],
};

export const NEW_SHIPPED_MD5 = {
  'fableloom-weave-episode.md': '990cdecf9e46fa049ae4aae27e3b172d',
  'fableloom-branch-node.md': 'e5005826c4577623ba362a0292741c7c',
  'fableloom-feedback-episode.md': '9ff21b47c4251585da9500c306d91a28',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom camera cuts',
  customizedHint: (filename) =>
    `   Merge the one-camera-cut contract and {{cameraMovementCatalog}} from\n`
    + `   data.reference/prompts/stages/${filename} into the installed template.`,
});

export { applyMigration };
export default { up };

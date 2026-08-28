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
  'fableloom-weave-episode.md': '4c9454d1537c4ebb3becbfa04fae3ed8',
  'fableloom-branch-node.md': 'ff5d40b3090c775fc9c1f48c2ea96bbd',
  'fableloom-feedback-episode.md': 'd09bb405478d24c294b0c658ef365cd1',
};

const { applyMigration, up } = makePromptReplaceMigration({
  accepted: ACCEPTED_OLD_MD5,
  current: NEW_SHIPPED_MD5,
  label: 'FableLoom camera cuts and interactive playback',
  customizedHint: (filename) =>
    `   Merge the one-camera-cut and playback-mode contracts plus {{cameraMovementCatalog}} from\n`
    + `   data.reference/prompts/stages/${filename} into the installed template.`,
});

export { applyMigration };
export default { up };

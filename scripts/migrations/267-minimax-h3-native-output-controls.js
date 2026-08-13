/**
 * Bring existing MiniMax H3 registry rows onto the model's published output
 * contract. Fresh installs receive these values from data.reference.
 *
 * Conservative customization rules:
 * - only the shipped PipeNetwork row is eligible;
 * - frameOptions changes only when it is byte-for-byte the prior shipped list;
 * - the native default-size pair is added only when both fields are absent;
 * - other resolution fields are added individually only when absent, so an
 *   explicit custom value (including an empty options list) remains user-owned.
 */

import { readMediaRegistry, writeMediaRegistry } from './_lib.js';

const REL_PATH = 'data/media-models.json';
const H3_ID = 'minimax_h3_8bit';
const SHIPPED_REPO = 'pipenetwork/MiniMax-H3-MLX-8bit';
const OLD_FRAME_OPTIONS = [124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362];
const NEW_FRAME_OPTIONS = [107, ...OLD_FRAME_OPTIONS];
const NATIVE_RESOLUTIONS = [
  { label: '1536x672 (21:9 H3 native)', w: 1536, h: 672 },
  { label: '1344x768 (16:9 H3 default)', w: 1344, h: 768 },
  { label: '1024x768 (4:3 H3 native)', w: 1024, h: 768 },
  { label: '768x768 (1:1 H3 native)', w: 768, h: 768 },
  { label: '768x1024 (3:4 H3 native)', w: 768, h: 1024 },
  { label: '768x1344 (9:16 H3 native)', w: 768, h: 1344 },
];

const sameValues = (left, right) => (
  Array.isArray(left)
  && left.length === right.length
  && left.every((value, index) => value === right[index])
);

export default {
  async up({ rootDir }) {
    const { ok, config, entries: macos, path } = await readMediaRegistry({ rootDir });
    if (!ok) return;

    const entry = macos.find((model) => model?.id === H3_ID);
    if (!entry) {
      console.log(`✅ ${REL_PATH}: no '${H3_ID}' entry — user removed it, nothing to migrate`);
      return;
    }
    if (entry.repo !== SHIPPED_REPO) {
      console.log(`✅ ${REL_PATH}: '${H3_ID}' points at ${entry.repo} — user-repointed, leaving it alone`);
      return;
    }

    let changed = false;
    if (sameValues(entry.frameOptions, OLD_FRAME_OPTIONS)) {
      entry.frameOptions = [...NEW_FRAME_OPTIONS];
      changed = true;
    }
    if (!Object.hasOwn(entry, 'defaultWidth') && !Object.hasOwn(entry, 'defaultHeight')) {
      entry.defaultWidth = 1344;
      entry.defaultHeight = 768;
      changed = true;
    }
    if (!Object.hasOwn(entry, 'resolutionStep')) {
      entry.resolutionStep = 32;
      changed = true;
    }
    if (!Object.hasOwn(entry, 'resolutionOptions')) {
      entry.resolutionOptions = structuredClone(NATIVE_RESOLUTIONS);
      changed = true;
    }

    if (changed) {
      await writeMediaRegistry(path, config);
      console.log(`📝 ${REL_PATH}: added MiniMax H3's 4-second option and native 768p canvases`);
    } else {
      console.log(`✅ ${REL_PATH}: MiniMax H3 output controls already current or customized`);
    }
  },
};

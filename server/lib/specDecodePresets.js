/**
 * Speculative-decoding launcher presets (llama-server target + drafter pairs).
 *
 * Server-owned because the paths are only half the story: each preset also
 * carries the Hugging Face repo the GGUF comes from, so PortOS can report
 * "downloaded / not downloaded" per file and fetch the missing ones itself.
 * The client renders this list — it holds no copy of its own, so a preset can
 * never name a path the downloader has no source for.
 *
 * `quant` is a HINT, not a filename: repos rename their builds
 * (`…-Q4_K_M.gguf`, `…-instruct-q4_k_m.gguf`, `….Q4_K_M.gguf`) and a hard-coded
 * filename rots the moment one of them re-uploads. `file`, when present, wins.
 *
 * A file with no published single-file GGUF (the DSpark 8B block ships as a
 * tokenizer-less checkpoint that has to be converted against its target) simply
 * carries no `repo` — the UI then links out to a Hugging Face search instead of
 * offering a Download button that cannot work. Pairs are the ones documented in
 * docs/features/dflash2.md; see also docs/research/2026-08-19-dspark-vs-dflash2.md.
 */

// llama.cpp exposes one `--spec-type` per drafter family. `draft-dspark` merged
// upstream on 2026-07-28 (ggml-org/llama.cpp#25173) and works on a stock
// `brew install llama.cpp`; `draft-dflash` covers DFlash v1, while the DFlash 2
// modules are still an open PR (#27342) and need a from-source build. Hence the
// DSpark presets lead.
export const SPEC_DECODE_PRESETS = Object.freeze([
  {
    id: 'qwen3.8-27b-dspark',
    label: 'Qwen 3.8 27B + DSpark Drafter (Recommended — stock llama.cpp)',
    specType: 'draft-dspark',
    model: {
      path: 'models/Qwen3.8-27B-Q4_K_M.gguf',
      repo: 'ggml-org/Qwen3.8-27B-GGUF',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/Qwen3.8-27B-DSpark-BF16.gguf',
      repo: 'erlidev/Qwen3.8-27B-DSpark-GGUF',
      quant: 'BF16',
    },
  },
  {
    id: 'qwen3-8b-dspark',
    label: 'Qwen 3 8B + DSpark Drafter (small target)',
    specType: 'draft-dspark',
    model: {
      path: 'models/Qwen3-8B-Q4_K_M.gguf',
      repo: 'Qwen/Qwen3-8B-GGUF',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/dspark_qwen3_8b_block7-bf16.gguf',
    },
  },
  {
    id: 'qwen3.8-27b',
    label: 'Qwen 3.8 27B + DFlash 2 Drafter (needs llama.cpp PR #27342 build)',
    specType: 'draft-dflash',
    model: {
      path: 'models/Qwen3.8-27B-Q4_K_M.gguf',
      repo: 'ggml-org/Qwen3.8-27B-GGUF',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/Qwen3.8-27B-DFlash2-Q4_K_M.gguf',
      repo: 'incoai/Qwen3.8-27B-DFlash2-GGUF',
      quant: 'Q4_K_M',
    },
  },
  {
    id: 'muse-glimmer-30b',
    label: 'Muse-Glimmer 30B + DFlash 2 Drafter (needs llama.cpp PR #27342 build)',
    specType: 'draft-dflash',
    model: {
      path: 'models/Muse-Glimmer-30B-Q4_K_M.gguf',
      repo: 'meta-models/Muse-Glimmer-30B-GGUF',
      // Pinned: this repo publishes the target next to its own `dflash-` drafter
      // and `mmproj-` projector, all three carrying the Q4_K_M tag, so the quant
      // hint alone cannot pick the 17 GB target out of the 1.4 GB sidecars.
      file: 'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf',
      quant: 'Q4_K_M',
    },
    draftModel: {
      path: 'models/Muse-Glimmer-30B-DFlash2-Q4_K_M.gguf',
      repo: 'z-lab/Muse-Glimmer-30B-DFlash2-GGUF',
      quant: 'Q4_K_M',
    },
  },
  {
    id: 'custom',
    label: 'Custom GGUF / Manual Paths',
    specType: 'draft-dspark',
    model: { path: '' },
    draftModel: { path: '' },
  },
]);

// The preset the launcher mounts on, and the roles a download request may name.
export const DEFAULT_SPEC_PRESET_ID = 'qwen3.8-27b-dspark';
export const SPEC_MODEL_ROLES = Object.freeze(['model', 'draftModel']);

export const findSpecDecodePreset = (id) =>
  SPEC_DECODE_PRESETS.find((preset) => preset.id === id) || null;

/**
 * The download source for one preset role, or null when the preset has no
 * published GGUF for it (`custom`, or a drafter that ships safetensors only).
 */
export const specDecodeSource = (presetId, role) => {
  const entry = findSpecDecodePreset(presetId)?.[role];
  return entry?.repo && entry?.path ? entry : null;
};

// Where to send a user whose preset has no automatic source. Searching by the
// filename (minus its extension) is what actually finds these — the drafter
// repos are named after the file, not the target model.
export const hfSearchUrl = (path) =>
  `https://huggingface.co/models?search=${encodeURIComponent(String(path).split('/').pop().replace(/\.gguf$/i, ''))}`;

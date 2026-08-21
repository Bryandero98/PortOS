/**
 * Image-to-3D — the one builder for a degraded-but-working install's projection.
 *
 * Two lanes report a half-built install: TRELLIS.2's texture-bake backends (`.metal`
 * sources that `setup.sh` compiles while still exiting 0) and Pixal3D's CUDA extensions
 * (same failure mode, different toolchain). Both surface the same two halves — the
 * remedy to run, and WHICH compiled modules are missing — through the same two
 * consumers: the card's `degraded` projection, which has a second line for the culprits,
 * and the install `verify` frame, which has one prose string and no second line.
 *
 * So the split lives here rather than in either lane. `describeDegradedInstall` assembles
 * both consumers from one description, which is what keeps `help` free of the module
 * names (the card would otherwise print them twice, and in two different wordings) while
 * the prose frame still carries them.
 *
 * Pure, and deliberately shaped around a plain `string[]` rather than either lane's probe
 * result: the caller does the `.missing` lookup, so a probe growing a second list of
 * names can format it through the same helpers.
 */

/**
 * A standalone card line naming the modules (`Missing: o_voxel, flex_gemm`).
 *
 * Punctuation-free — a card line wants none, so the terminal period is
 * `appendMissingModules`'s job. Returning `''` rather than a bare "Missing:" is what
 * lets `describeDegradedInstall` omit the key entirely: a degradation with nothing to
 * name (Pixal3D's NAF fallback — NATTEN is absent as a whole, not half-built) must not
 * render an empty detail line.
 *
 * @param {string[]|undefined} missing module names the probe found absent
 * @returns {string}
 */
export function missingModulesLabel(missing) {
  return missing?.length ? `Missing: ${missing.join(', ')}` : '';
}

/**
 * Remedy prose with the culprit modules appended as a closing sentence
 * (`… models are kept. Missing: o_voxel.`), for the lanes that can only emit one string
 * and have no second line to put a label on.
 *
 * @param {string} help the remedy prose (already ends in its own punctuation)
 * @param {string[]|undefined} missing module names the probe found absent
 * @returns {string}
 */
export function appendMissingModules(help, missing) {
  const label = missingModulesLabel(missing);
  return label ? `${help} ${label}.` : help;
}

/**
 * Both consumers of one degraded install state, from one description.
 *
 * `degraded` is the normalized card projection every target shares (see the adapter
 * contract in `adapters.js`); `warnings` is the prose the install route replays into its
 * `verify` stage. Assembling them per-adapter instead is how the two drift: one target
 * ends up interpolating the module names into `help` and the other styling them as a
 * line, for one condition (#4741).
 *
 * @param {object} args
 * @param {string} args.label short badge text (`incomplete install`)
 * @param {string} args.help the remedy, and ONLY the remedy — never the culprit names
 * @param {boolean} [args.repairable=true] can re-running install fix it?
 * @param {string[]} [args.missing] module names the probe found absent, when it knows
 * @returns {{degraded: {label: string, help: string, repairable: boolean, detail?: string},
 *   warnings: string[]}}
 */
export function describeDegradedInstall({ label, help, repairable = true, missing }) {
  const detail = missingModulesLabel(missing);
  return {
    degraded: { label, help, repairable, ...(detail ? { detail } : {}) },
    // A degradation whose probe produced no prose has nothing to say in a stage that
    // renders only prose — an empty list, never a `[undefined]` frame.
    warnings: help ? [appendMissingModules(help, missing)] : [],
  };
}

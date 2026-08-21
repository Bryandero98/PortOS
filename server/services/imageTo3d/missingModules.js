/**
 * Image-to-3D — the one wording for "these compiled modules did not build".
 *
 * Two lanes report a half-built install: TRELLIS.2's texture-bake backends
 * (`.metal` sources that `setup.sh` compiles while still exiting 0) and Pixal3D's
 * CUDA extensions (same failure mode, different toolchain). Both surface the culprit
 * module names, in the card's `degraded.detail` line AND in the prose the install's
 * `verify` frame prints — so the string lives here rather than in either lane, and
 * one condition cannot read two different ways depending on which target hit it.
 *
 * Pure, and deliberately shaped around a plain `string[]` rather than either lane's
 * probe result: the caller does the `.missing` lookup, so a probe growing a second
 * list of names can format it through the same helper.
 */

/**
 * A standalone card line naming the modules (`Missing: o_voxel, flex_gemm`).
 *
 * Punctuation-free — a card line wants none, so the terminal period is
 * `appendMissingModules`'s job.
 *
 * Returning `''` rather than a bare "Missing:" is defensive depth, not the thing that
 * keeps an indeterminate probe quiet: every caller gates on its own degraded signal
 * first, and a real probe reports that exactly when the list is non-empty.
 *
 * @param {string[]|undefined} missing module names the probe found absent
 * @returns {string}
 */
export function missingModulesLabel(missing) {
  return missing?.length ? `Missing: ${missing.join(', ')}` : '';
}

/**
 * Remedy prose with the culprit modules appended as a closing sentence
 * (`… models are kept. Missing: o_voxel.`), for the lanes that can only emit one
 * string and have no second line to put `detail` on.
 *
 * @param {string} help the remedy prose (already ends in its own punctuation)
 * @param {string[]|undefined} missing module names the probe found absent
 * @returns {string}
 */
export function appendMissingModules(help, missing) {
  const label = missingModulesLabel(missing);
  return [help, label && `${label}.`].filter(Boolean).join(' ');
}

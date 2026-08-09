/**
 * Seed the three canon/arc stages that shipped a `.md` template but never got a
 * `stage-config.json` entry.
 *
 * `pipeline-character-refine`, `pipeline-character-differentiate-cast`, and
 * `pipeline-arc-resolve` all landed with their templates in
 * `data.reference/prompts/stages/` while the matching stage-config entries were
 * never authored. `promptService.buildPrompt()` resolves a stage through
 * `getStage()` (stage-config), NOT through the template file — so every install,
 * fresh or upgraded, threw `Stage <name> not found` the moment the user pressed
 * "AI: differentiate cast" / "AI: differentiate" on the Universe Canon view, or
 * ran arc-verification auto-resolve. The entries are added to
 * `data.reference/prompts/stage-config.json` in the same change; this migration
 * is what carries them onto installs that already have a `data/` tree.
 *
 * Customization-safe + idempotent per `_seedStageHelpers.js` — each template is
 * copied only when missing and each config entry merged only when absent, so an
 * install whose templates are already present (the common case here, since the
 * `.md` files did ship) picks up only the config entries.
 */

import { makeSeedMigrations } from './_seedStageHelpers.js';

export default makeSeedMigrations([
  'pipeline-character-refine',
  'pipeline-character-differentiate-cast',
  'pipeline-arc-resolve',
]);

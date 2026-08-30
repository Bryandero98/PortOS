/**
 * Recognizing a stored prompt as a shipped default.
 *
 * Shared by taskScheduleStore.js (legacy-version inference + the
 * promptCustomized self-heal) and taskPromptService.js (claim-flow default
 * resolution), which previously carried byte-identical copies of this check.
 * A genuine user edit never matches a shipped default, so a match means the
 * stored prompt is safe to auto-upgrade.
 *
 * See ../taskPromptDefaults.js and AGENTS.md "Distribution model".
 */
import { DEFAULT_TASK_PROMPTS } from './prompts.js';
import { PREVIOUS_DEFAULT_PROMPTS } from './previousDefaults.js';

// The basic improvement prompts shipped under an `[App Improvement: {appName}]`
// header until the self-improvement / app-improvement schedules were unified,
// which renamed it to `[Improvement: {appName}]` without preserving the
// outgoing bodies in PREVIOUS_DEFAULT_PROMPTS. Installs carrying that
// generation therefore stopped matching any shipped default, were flagged
// `promptCustomized` by the legacy migration, and have been frozen out of every
// prompt upgrade since. For most task types the rename changed the header line
// and nothing else, so normalize it on both sides instead of re-registering a
// near-duplicate body per task type. (Bodies that changed further in the same
// era — `security`, `feature-ideas` — still carry their own entry.)
const LEGACY_HEADER = '[App Improvement: ';
const CURRENT_HEADER = '[Improvement: ';

export const normalizeLegacyPromptHeader = (prompt) => (
  typeof prompt === 'string' && prompt.startsWith(LEGACY_HEADER)
    ? CURRENT_HEADER + prompt.slice(LEGACY_HEADER.length)
    : prompt
);

/**
 * True when a stored prompt matches a shipped default for this task — the
 * current default or any prior one in PREVIOUS_DEFAULT_PROMPTS — ignoring the
 * retired `[App Improvement: …]` header spelling.
 */
export function promptMatchesShippedDefault(prompt, taskType) {
  if (!prompt || !DEFAULT_TASK_PROMPTS[taskType]) return false;
  const normalized = normalizeLegacyPromptHeader(prompt);
  return (
    normalized === DEFAULT_TASK_PROMPTS[taskType] ||
    (PREVIOUS_DEFAULT_PROMPTS[taskType] || []).some(
      (body) => normalizeLegacyPromptHeader(body) === normalized
    )
  );
}

/**
 * slashdo-compatible dispatch-hint labels for planner-driven issue filing.
 *
 * Two independent axes — capability (`model:`) and reasoning budget (`effort:`) —
 * plus the prescribed forge colors, validation, and label-formatting helpers.
 * Omit an axis when the evidence does not justify it; never stamp `medium` on
 * both by reflex. Do not derive one axis from the other, or from complexity.
 *
 * GitHub/GitLab use the colon form (`model:light`). Jira labels cannot carry
 * a colon on some versions, so Jira gets the hyphen form (`model-light`).
 *
 * Contributor labels (`good first issue`, `help wanted`) are a third, equally
 * optional axis: apply them when the work is actually onboarding-shaped, not
 * because `model` happened to be `light`.
 */

import { shellQuote } from './shellQuote.js';

export const DISPATCH_MODEL_TIERS = Object.freeze(['light', 'medium', 'heavy']);
export const DISPATCH_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export const DISPATCH_LABEL_COLORS = Object.freeze({
  'model:light': 'D4C5F9',
  'model:medium': 'A371F7',
  'model:heavy': '6F42C1',
  'effort:low': 'BFE5E5',
  'effort:medium': '76C7C7',
  'effort:high': '1D7874',
  'effort:xhigh': '0E4F4C',
  'effort:max': '05403D',
});

export const DISPATCH_LABEL_DESCRIPTIONS = Object.freeze({
  'model:light': 'Dispatch capability: cheapest capable coding model',
  'model:medium': 'Dispatch capability: routine workhorse coding model',
  'model:heavy': 'Dispatch capability: strongest available coding model',
  'effort:low': 'Dispatch reasoning effort: low',
  'effort:medium': 'Dispatch reasoning effort: medium',
  'effort:high': 'Dispatch reasoning effort: high',
  'effort:xhigh': 'Dispatch reasoning effort: extra-high',
  'effort:max': 'Dispatch reasoning effort: maximum',
});

/** GitHub/GitLab contributor labels — optional, independently justified. */
export const GOOD_FIRST_ISSUE_LABEL = 'good first issue';
export const HELP_WANTED_LABEL = 'help wanted';

/** Jira-safe (no spaces) equivalents. */
export const JIRA_GOOD_FIRST_ISSUE_LABEL = 'good-first-issue';
export const JIRA_HELP_WANTED_LABEL = 'help-wanted';

/** GitHub's default colors so a lazily-created label matches the platform convention. */
export const CONTRIBUTOR_LABEL_COLORS = Object.freeze({
  [GOOD_FIRST_ISSUE_LABEL]: '7057FF',
  [HELP_WANTED_LABEL]: '008672',
});

export const CONTRIBUTOR_LABEL_DESCRIPTIONS = Object.freeze({
  [GOOD_FIRST_ISSUE_LABEL]: 'Self-contained work a new contributor can ship without deep repo context',
  [HELP_WANTED_LABEL]: 'Extra hands welcome — scoped enough to pick up cold',
});

const MODEL_SET = new Set(DISPATCH_MODEL_TIERS);
const EFFORT_SET = new Set(DISPATCH_EFFORT_LEVELS);

/** True when `value` is a recognized `model:` tier (`light` / `medium` / `heavy`). */
export function isDispatchModel(value) {
  return typeof value === 'string' && MODEL_SET.has(value);
}

/** True when `value` is a recognized `effort:` level. */
export function isDispatchEffort(value) {
  return typeof value === 'string' && EFFORT_SET.has(value);
}

/** Valid tier, else null. Unknown / absent / non-string → omit the axis. */
export function normalizeDispatchModel(value) {
  return isDispatchModel(value) ? value : null;
}

/** Valid level, else null. Unknown / absent / non-string → omit the axis. */
export function normalizeDispatchEffort(value) {
  return isDispatchEffort(value) ? value : null;
}

/**
 * Forge (GitHub/GitLab) label name for one axis, or null when the value is
 * unrecognized. `axis` is `'model'` or `'effort'`.
 */
export function forgeDispatchLabel(axis, value) {
  if (axis === 'model') {
    const tier = normalizeDispatchModel(value);
    return tier ? `model:${tier}` : null;
  }
  if (axis === 'effort') {
    const level = normalizeDispatchEffort(value);
    return level ? `effort:${level}` : null;
  }
  return null;
}

/**
 * Jira-safe label for one axis (`model-light`, `effort-max`). Colon-free so it
 * survives Jira versions that reject `:`. Null when the value is unrecognized.
 */
export function jiraDispatchLabel(axis, value) {
  const forge = forgeDispatchLabel(axis, value);
  return forge ? forge.replace(':', '-') : null;
}

/**
 * Valid forge labels for the supplied hints, omitting any unjustified axis.
 * Never invents a default; never derives one axis from the other.
 */
export function forgeDispatchLabels({ model, effort } = {}) {
  return [forgeDispatchLabel('model', model), forgeDispatchLabel('effort', effort)].filter(Boolean);
}

/** Jira-safe equivalents of `forgeDispatchLabels`. */
export function jiraDispatchLabels({ model, effort } = {}) {
  return [jiraDispatchLabel('model', model), jiraDispatchLabel('effort', effort)].filter(Boolean);
}

/**
 * Optional contributor labels. `goodFirstIssue` / `helpWanted` are strict
 * booleans — only an explicit `true` applies the label. A light model tier
 * does NOT imply `good first issue` (a 40-file mechanical sweep is light and
 * a terrible first issue).
 */
export function forgeContributorLabels({ goodFirstIssue, helpWanted } = {}) {
  const labels = [];
  if (goodFirstIssue === true) labels.push(GOOD_FIRST_ISSUE_LABEL);
  if (helpWanted === true) labels.push(HELP_WANTED_LABEL);
  return labels;
}

export function jiraContributorLabels({ goodFirstIssue, helpWanted } = {}) {
  const labels = [];
  if (goodFirstIssue === true) labels.push(JIRA_GOOD_FIRST_ISSUE_LABEL);
  if (helpWanted === true) labels.push(JIRA_HELP_WANTED_LABEL);
  return labels;
}

/** Dispatch hints + contributor labels for one GitHub/GitLab issue. */
export function forgeIssueLabels({ model, effort, goodFirstIssue, helpWanted } = {}) {
  return [
    ...forgeDispatchLabels({ model, effort }),
    ...forgeContributorLabels({ goodFirstIssue, helpWanted }),
  ];
}

/** Dispatch hints + contributor labels for one Jira ticket. */
export function jiraIssueLabels({ model, effort, goodFirstIssue, helpWanted } = {}) {
  return [
    ...jiraDispatchLabels({ model, effort }),
    ...jiraContributorLabels({ goodFirstIssue, helpWanted }),
  ];
}

/** `{ name, color, description }` for a forge dispatch or contributor label, or null. */
export function dispatchLabelSpec(name) {
  if (typeof name !== 'string') return null;
  if (DISPATCH_LABEL_COLORS[name]) {
    return {
      name,
      color: DISPATCH_LABEL_COLORS[name],
      description: DISPATCH_LABEL_DESCRIPTIONS[name],
    };
  }
  if (CONTRIBUTOR_LABEL_COLORS[name]) {
    return {
      name,
      color: CONTRIBUTOR_LABEL_COLORS[name],
      description: CONTRIBUTOR_LABEL_DESCRIPTIONS[name],
    };
  }
  return null;
}

/** All eight slashdo dispatch-label specs, in axis-then-ramp order. */
export function allDispatchLabelSpecs() {
  return Object.keys(DISPATCH_LABEL_COLORS).map((name) => dispatchLabelSpec(name));
}

/**
 * One-line forge `label create` for a dispatch label. Idempotent form
 * (`2>/dev/null || true` / `--force` is the caller's choice). Returns null
 * when `name` is not a dispatch label.
 */
export function formatLabelCreateCommand(name, { cli = 'gh' } = {}) {
  const spec = dispatchLabelSpec(name);
  if (!spec) return null;
  const quoted = shellQuote(spec.name);
  if (cli === 'glab') {
    return `glab label create --name ${quoted} --color ${shellQuote(`#${spec.color}`)} --description ${shellQuote(spec.description)} 2>/dev/null || true`;
  }
  return `gh label create ${quoted} --color ${spec.color} --description ${shellQuote(spec.description)} 2>/dev/null || true`;
}

/** Repeated `--label <name>` flags — one per label, never a comma list. */
export function formatRepeatedLabelFlags(labels = []) {
  return labels
    .filter((label) => typeof label === 'string' && label.trim())
    .map((label) => `--label ${shellQuote(label.trim())}`)
    .join(' ');
}

/**
 * Shared quality gate for any scheduled planner that files tracker work.
 * This deliberately allows worthwhile refactors while rejecting proposals whose
 * only justification is a possible future trigger or a speculative abstraction.
 */
export const ISSUE_QUALITY_GUIDANCE = [
  'Issue-quality gate: File current, evidenced work with impact and a chosen fix. Drop future-only/speculative refactors; current refactors that pay off now are valid.',
].join('\n');

/**
 * Standing guidance for any planner that files GitHub/GitLab issues. Used in
 * tracker-filing instructions, quota-burn audits, claim follow-ups, and the
 * file-issue skill so the vocabulary cannot drift.
 */
export const DISPATCH_HINT_GUIDANCE = [
  'Dispatch hints (`model:` + `effort:`) are optional, independent labels recommending HOW to run the work — not a size estimate:',
  '- `model:light|medium|heavy` — capability: light is mechanical (rename, config, well-specified edit); heavy is genuinely hard reasoning (concurrency, redesign).',
  '- `effort:low|medium|high|xhigh|max` — reasoning budget per step, independent of model. `model:light` + `effort:max` is a mechanical sweep across many call sites; `model:heavy` + `effort:low` is a two-line change that hinges on one idea.',
  'Choose each axis only when the work you just inspected justifies it. Omit an axis rather than guessing. Do NOT stamp `medium` on both by reflex, and do NOT put `[model:…]` / `[effort:…]` / `[category]` / `[SEVERITY]` in the title — those belong in labels.',
  'Create each missing hint label immediately before applying it (`gh label create <name> --color <hex> 2>/dev/null || true`; glab needs `--name` and `#<hex>`). Colors: model:light D4C5F9, model:medium A371F7, model:heavy 6F42C1, effort:low BFE5E5, effort:medium 76C7C7, effort:high 1D7874, effort:xhigh 0E4F4C, effort:max 05403D.',
  'Also apply contributor labels when the work actually fits them — independently of `model:`/`effort:`:',
  '- `good first issue` (color 7057FF) — self-contained, well-specified, a new contributor can ship it without deep repo context. A `model:light` 40-file sweep is NOT a good first issue.',
  '- `help wanted` (color 008672) — extra hands welcome and the body is scoped enough to pick up cold.',
  'Create those two with the same `gh` / `glab label create` form as the dispatch hints (quote the name; glab still needs `--name` and `#<hex>`).',
  'Use repeated `--label` flags (one per label). Preserve existing category/scope labels (`plan`, `ux`, `bug`, `tests`, `layered-intelligence`, …). Never relabel a deduplicated existing issue.',
  ISSUE_QUALITY_GUIDANCE,
].join('\n');

/**
 * Jira sibling of `DISPATCH_HINT_GUIDANCE`. Same vocabulary, hyphenated label
 * names (`model-light`, `effort-max`) because a colon is unsafe on some Jira
 * versions.
 */
export const JIRA_DISPATCH_HINT_GUIDANCE = [
  'Dispatch hints are optional, independent Jira labels recommending HOW to run the work — not a size estimate:',
  '- `model-light|model-medium|model-heavy` — capability (mechanical vs. hard reasoning).',
  '- `effort-low|effort-medium|effort-high|effort-xhigh|effort-max` — reasoning budget per step, independent of model.',
  'Choose each axis only when the work you just inspected justifies it. Omit an axis rather than guessing. Do NOT stamp `medium` on both by reflex, and do NOT put `[model-…]` / `[effort-…]` / `[category]` / `[SEVERITY]` in the summary — those belong in labels.',
  'Also apply contributor labels when the work actually fits them — independently of the dispatch axes: `good-first-issue` (self-contained, a new contributor can ship it) and `help-wanted` (extra hands welcome, scoped enough to pick up cold). A `model-light` 40-file sweep is NOT a good-first-issue.',
  'Preserve existing category/scope labels. Never relabel a ticket you skipped as a duplicate.',
  ISSUE_QUALITY_GUIDANCE,
].join('\n');

/**
 * Current PortOS scope-label vocabulary. The forge remains the source of truth
 * at filing time (`gh label list --search area:` / `glab label list`), while this
 * list keeps autonomous prompts aware of the established labels instead of
 * inventing a new area for every reference study.
 */
export const PORTOS_AREA_LABELS = Object.freeze([
  'area:database',
  'area:songs',
  'area:federation',
  'area:pipeline',
  'area:story-builder',
  'area:writers-room',
  'area:create',
  'area:openworld',
  'area:brain',
  'area:cos-agents',
  'area:identity',
  'area:content',
  'area:devtools',
  'area:ui',
  'area:post',
  'area:privacy',
  'area:life-tracking',
  'area:media',
]);

/** Shared scope guidance for the one-shot repo-study label contract. */
export const PORTOS_AREA_LABEL_GUIDANCE = [
  'Scope labels (`area:*`) are required for repo-study issues. Inspect the target files and apply every relevant existing area label, preferring the narrowest label rather than a generic guess.',
  `The current PortOS area vocabulary is: ${PORTOS_AREA_LABELS.join(', ')}. Re-check the forge with \`gh label list --search area:\` or \`glab label list\` before filing; create a genuinely missing, clearly scoped area label before applying it instead of omitting scope (GitHub: \`gh label create <name> --color 0366D6 --description \"…\" --force\`; GitLab: \`glab label create --name <name> --color \"#0366D6\" --description \"…\"\`).`,
].join('\n');

/**
 * Repo studies have enough target-code evidence to make all three routing
 * decisions. Keep this contract separate from the general guidance, where the
 * model/effort axes are intentionally optional for other issue producers.
 */
export const REPO_STUDY_LABEL_CONTRACT = Object.freeze({
  forgeFlags: '--label area:<area> --label model:<tier> --label effort:<level>',
  jiraFlags: '`area:<area>` + `model-<tier>` + `effort-<level>`',
  instructions: [
    '**Repo-study complete-label contract (mandatory):** every NEW proposal must carry `repo-study`, `plan`, at least one relevant `area:*`, exactly one justified model label (`model:*` on GitHub/GitLab, `model-*` on JIRA), and exactly one justified effort label (`effort:*` on GitHub/GitLab, `effort-*` on JIRA). The dispatch axes are independent: choose them from the inspected PortOS files and proposed implementation, never by stamping `medium` on both.',
    PORTOS_AREA_LABEL_GUIDANCE,
    'If a proposal cannot be classified defensibly on all three axes, do not file that proposal; filing an incomplete issue is not a valid fallback. After each NEW issue, read its labels back and repair any missing required label before continuing; never relabel a duplicate you skipped. Contributor labels remain optional and must follow the shared guidance.',
  ].join('\n'),
});

/** Repo-study contract for managed apps whose label taxonomy is not PortOS's. */
export const GENERIC_REPO_STUDY_LABEL_CONTRACT = Object.freeze({
  forgeFlags: '--label area:<area> --label model:<tier> --label effort:<level>',
  jiraFlags: '`area:<area>` + `model-<tier>` + `effort-<level>`',
  instructions: [
    '**Repo-study complete-label contract (mandatory):** every NEW proposal must carry `repo-study`, `plan`, at least one relevant `area:*`, exactly one justified model label (`model:*` on GitHub/GitLab, `model-*` on JIRA), and exactly one justified effort label (`effort:*` on GitHub/GitLab, `effort-*` on JIRA). The dispatch axes are independent: choose them from the inspected target-app files and proposed implementation, never by stamping `medium` on both.',
    'Scope labels (`area:*`) are required for repo-study issues. Inspect the target app\'s existing tracker labels and apply the narrowest relevant labels; create a genuinely missing, clearly scoped area label only when the tracker supports it.',
    'If a proposal cannot be classified defensibly on all three axes, do not file that proposal; filing an incomplete issue is not a valid fallback. After each NEW issue, read its labels back and repair any missing required label before continuing; never relabel a duplicate you skipped. Contributor labels remain optional and must follow the shared guidance.',
  ].join('\n'),
});

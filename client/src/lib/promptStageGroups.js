/**
 * Prompt-stage search + grouping for the Prompt Manager's Stages pane (#3284).
 *
 * The stage list is 120+ entries deep and the taxonomy is already encoded in the
 * display names — `Pipeline — Prose Draft`, `Writers Room — Live Continuation`,
 * `CoS Agent Briefing`. These helpers turn that convention into navigable
 * structure: an AND-token filter over title + description + key, then ordered
 * groups keyed on the name's prefix.
 *
 * Token semantics are shared with the media browser (`mediaSearch.js`) rather
 * than re-rolled — same "every whitespace term must match somewhere" contract
 * users already learned there.
 *
 * Pure — no React, no I/O. The page owns the disclosure state and icons.
 */

import { tokenizeQuery, matchHaystack } from './mediaSearch.js';

// Stages PortOS features call by name. Mirror of the `systemStages` table in
// `server/routes/prompts.js` — the server is authoritative for *deletion*
// (it force-guards on its own copy); this copy only drives the SYSTEM badge and
// the SYSTEM-only filter, so a drift here is cosmetic, never destructive.
export const SYSTEM_STAGE_KEYS = [
  'cos-agent-briefing', 'cos-evaluate', 'cos-report-summary', 'cos-self-improvement',
  'cos-task-enhance', 'brain-classifier', 'brain-daily-digest', 'brain-weekly-review',
  'memory-evaluate', 'app-detection',
];

const SYSTEM_STAGE_SET = new Set(SYSTEM_STAGE_KEYS);

export function isSystemStage(key) {
  return SYSTEM_STAGE_SET.has(key);
}

// Bucket for names that carry neither a dash prefix nor a known leading word.
export const OTHER_GROUP_LABEL = 'Other';

// Most names encode their family as `<Family> — <specific>` (em or en dash).
const DASH_PREFIX_RE = /^(.+?)\s[—–]\s/;

// Families whose names predate the dash convention (`CoS Agent Briefing`,
// `Brain Classifier`). Matched as a leading WORD run so `Model Personality`
// wins over a hypothetical `Model` — longest-first ordering is what makes that
// deterministic, so keep multi-word entries above their prefixes.
export const STAGE_WORD_PREFIXES = [
  'Model Personality',
  'App Detection',
  'Brain',
  'CoS',
  'Memory',
  'Soul',
  'Twin',
];

// Lowercased once at module load — the match below runs per stage per keystroke.
const LOWERED_WORD_PREFIXES = STAGE_WORD_PREFIXES.map((prefix) => [prefix, prefix.toLowerCase()]);

/**
 * The group a stage belongs to, derived from its display name (falling back to
 * its key when a stage has no name). Hyphens normalize to spaces first so a
 * name-less `cos-evaluate` still lands under CoS rather than in Other.
 */
export function stageGroupLabel(displayName) {
  const name = String(displayName || '').trim();
  if (!name) return OTHER_GROUP_LABEL;

  const dashed = DASH_PREFIX_RE.exec(name);
  if (dashed) {
    const prefix = dashed[1].trim();
    if (prefix) return prefix;
  }

  const normalized = name.replace(/-/g, ' ').toLowerCase();
  for (const [prefix, needle] of LOWERED_WORD_PREFIXES) {
    if (normalized === needle || normalized.startsWith(`${needle} `)) return prefix;
  }
  return OTHER_GROUP_LABEL;
}

/**
 * The group for a `[key, config]` pair — the display name when it has one,
 * else the key. The single definition of that fallback: the page's
 * auto-expand and this module's bucketing must agree on the label, or a
 * deep-linked stage opens the wrong group.
 */
export function stageGroupLabelFor(key, config) {
  return stageGroupLabel(config?.name || key);
}

/**
 * The lowercased searchable string for one stage. Title and description are
 * what the issue asks for; the raw key rides along so a user who knows the
 * stage id (`brain-daily-digest`) can type it directly.
 */
export function stageHaystack(key, config) {
  return `${config?.name || ''} ${config?.description || ''} ${key || ''}`.toLowerCase();
}

/**
 * Filter + group the stage map for the Stages pane.
 *
 * `stages` is the `{ key: config }` map the prompts API returns. Returns
 * `{ groups, matchCount, totalCount }` where each group is
 * `{ label, stages: [[key, config], …] }` — groups sorted alphabetically with
 * `Other` pinned last, stages sorted by display name within a group.
 *
 * An empty query and `systemOnly: false` return everything, so the same call
 * drives both the unfiltered and the filtered render.
 */
export function buildStageGroups(stages, { query = '', systemOnly = false } = {}) {
  const entries = Object.entries(stages || {});
  const tokens = tokenizeQuery(query);

  const matched = entries.filter(([key, config]) => {
    if (systemOnly && !isSystemStage(key)) return false;
    if (tokens.length === 0) return true;
    return matchHaystack(stageHaystack(key, config), tokens);
  });

  const byLabel = new Map();
  for (const entry of matched) {
    const label = stageGroupLabelFor(entry[0], entry[1]);
    const list = byLabel.get(label);
    if (list) list.push(entry); else byLabel.set(label, [entry]);
  }

  // `Other` sorts last; everything else alphabetically. Ranking rather than
  // branching so a second pinned bucket is one table entry, not a rewrite.
  const rank = (label) => (label === OTHER_GROUP_LABEL ? 1 : 0);
  const groups = [...byLabel.entries()]
    .map(([label, list]) => ({
      label,
      stages: list.sort(([aKey, a], [bKey, b]) =>
        String(a?.name || aKey).localeCompare(String(b?.name || bKey))),
    }))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));

  return { groups, matchCount: matched.length, totalCount: entries.length };
}

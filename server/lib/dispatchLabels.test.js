import { describe, expect, it } from 'vitest';
import {
  DISPATCH_MODEL_TIERS,
  DISPATCH_EFFORT_LEVELS,
  DISPATCH_LABEL_COLORS,
  DISPATCH_HINT_GUIDANCE,
  JIRA_DISPATCH_HINT_GUIDANCE,
  GOOD_FIRST_ISSUE_LABEL,
  HELP_WANTED_LABEL,
  JIRA_GOOD_FIRST_ISSUE_LABEL,
  JIRA_HELP_WANTED_LABEL,
  isDispatchModel,
  isDispatchEffort,
  normalizeDispatchModel,
  normalizeDispatchEffort,
  forgeDispatchLabel,
  jiraDispatchLabel,
  forgeDispatchLabels,
  jiraDispatchLabels,
  forgeContributorLabels,
  jiraContributorLabels,
  forgeIssueLabels,
  jiraIssueLabels,
  dispatchLabelSpec,
  allDispatchLabelSpecs,
  formatLabelCreateCommand,
  formatRepeatedLabelFlags,
} from './dispatchLabels.js';

describe('dispatch label vocabulary', () => {
  it('is the exact slashdo model/effort set', () => {
    expect(DISPATCH_MODEL_TIERS).toEqual(['light', 'medium', 'heavy']);
    expect(DISPATCH_EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('prescribes slashdo colors for every forge label', () => {
    expect(DISPATCH_LABEL_COLORS).toEqual({
      'model:light': 'D4C5F9',
      'model:medium': 'A371F7',
      'model:heavy': '6F42C1',
      'effort:low': 'BFE5E5',
      'effort:medium': '76C7C7',
      'effort:high': '1D7874',
      'effort:xhigh': '0E4F4C',
      'effort:max': '05403D',
    });
  });

  it('accepts only the known enum values', () => {
    expect(isDispatchModel('light')).toBe(true);
    expect(isDispatchModel('heavy')).toBe(true);
    expect(isDispatchModel('none')).toBe(false);
    expect(isDispatchModel('model:light')).toBe(false);
    expect(isDispatchModel('')).toBe(false);
    expect(isDispatchModel(null)).toBe(false);

    expect(isDispatchEffort('xhigh')).toBe(true);
    expect(isDispatchEffort('max')).toBe(true);
    expect(isDispatchEffort('none')).toBe(false);
    expect(isDispatchEffort('effort:low')).toBe(false);
  });

  it('normalizes unknown/absent values to null instead of inventing a default', () => {
    expect(normalizeDispatchModel('medium')).toBe('medium');
    expect(normalizeDispatchModel('Medium')).toBe(null);
    expect(normalizeDispatchModel(undefined)).toBe(null);
    expect(normalizeDispatchEffort('low')).toBe('low');
    expect(normalizeDispatchEffort('')).toBe(null);
  });
});

describe('forge vs Jira label formatting', () => {
  it('formats independent axes and omits an unjustified one', () => {
    expect(forgeDispatchLabel('model', 'light')).toBe('model:light');
    expect(forgeDispatchLabel('effort', 'max')).toBe('effort:max');
    expect(forgeDispatchLabel('model', 'nope')).toBe(null);
    expect(forgeDispatchLabel('complexity', 'trivial')).toBe(null);

    expect(jiraDispatchLabel('model', 'heavy')).toBe('model-heavy');
    expect(jiraDispatchLabel('effort', 'xhigh')).toBe('effort-xhigh');
    expect(jiraDispatchLabel('effort', null)).toBe(null);
    expect(jiraDispatchLabel('model', 'heavy')).not.toContain(':');
  });

  it('does not derive one axis from the other or invent medium', () => {
    expect(forgeDispatchLabels({})).toEqual([]);
    expect(forgeDispatchLabels({ model: 'light' })).toEqual(['model:light']);
    expect(forgeDispatchLabels({ effort: 'high' })).toEqual(['effort:high']);
    expect(forgeDispatchLabels({ model: 'heavy', effort: 'low' })).toEqual(['model:heavy', 'effort:low']);
    expect(forgeDispatchLabels({ model: 'epic', effort: 'yes' })).toEqual([]);
    expect(jiraDispatchLabels({ model: 'light', effort: 'max' })).toEqual(['model-light', 'effort-max']);
  });
});

describe('label specs and CLI formatting', () => {
  it('returns a spec only for known dispatch labels', () => {
    expect(dispatchLabelSpec('model:light')).toEqual({
      name: 'model:light',
      color: 'D4C5F9',
      description: 'Dispatch capability: cheapest capable coding model',
    });
    expect(dispatchLabelSpec('plan')).toBe(null);
    expect(dispatchLabelSpec('model-light')).toBe(null);
  });

  it('lists all eight specs without dropping an axis', () => {
    const specs = allDispatchLabelSpecs();
    expect(specs).toHaveLength(8);
    expect(specs.map((s) => s.name)).toEqual(Object.keys(DISPATCH_LABEL_COLORS));
    expect(specs.every((s) => /^[0-9A-F]{6}$/.test(s.color))).toBe(true);
  });

  it('formats idempotent gh / glab create commands with slashdo colors', () => {
    expect(formatLabelCreateCommand('model:light')).toBe(
      "gh label create model:light --color D4C5F9 --description 'Dispatch capability: cheapest capable coding model' 2>/dev/null || true",
    );
    expect(formatLabelCreateCommand('effort:max', { cli: 'glab' })).toBe(
      "glab label create --name effort:max --color '#05403D' --description 'Dispatch reasoning effort: maximum' 2>/dev/null || true",
    );
    expect(formatLabelCreateCommand('plan')).toBe(null);
    expect(formatLabelCreateCommand(GOOD_FIRST_ISSUE_LABEL)).toBe(
      "gh label create 'good first issue' --color 7057FF --description 'Self-contained work a new contributor can ship without deep repo context' 2>/dev/null || true",
    );
  });

  it('applies contributor labels only on an explicit true, never from model:light', () => {
    expect(forgeContributorLabels({})).toEqual([]);
    expect(forgeContributorLabels({ goodFirstIssue: true })).toEqual([GOOD_FIRST_ISSUE_LABEL]);
    expect(forgeContributorLabels({ helpWanted: true })).toEqual([HELP_WANTED_LABEL]);
    expect(forgeContributorLabels({ goodFirstIssue: 'yes', helpWanted: 1 })).toEqual([]);
    expect(jiraContributorLabels({ goodFirstIssue: true, helpWanted: true }))
      .toEqual([JIRA_GOOD_FIRST_ISSUE_LABEL, JIRA_HELP_WANTED_LABEL]);
    expect(forgeIssueLabels({ model: 'light', goodFirstIssue: true }))
      .toEqual(['model:light', GOOD_FIRST_ISSUE_LABEL]);
    expect(forgeIssueLabels({ model: 'light' })).toEqual(['model:light']);
    expect(jiraIssueLabels({ effort: 'low', helpWanted: true }))
      .toEqual(['effort-low', JIRA_HELP_WANTED_LABEL]);
  });

  it('emits repeated --label flags, never a comma list', () => {
    expect(formatRepeatedLabelFlags(['plan', 'model:light', 'effort:max']))
      .toBe('--label plan --label model:light --label effort:max');
    expect(formatRepeatedLabelFlags(['ux', '', null, 'plan'])).toBe('--label ux --label plan');
    expect(formatRepeatedLabelFlags([])).toBe('');
    expect(formatRepeatedLabelFlags([GOOD_FIRST_ISSUE_LABEL, HELP_WANTED_LABEL]))
      .toBe("--label 'good first issue' --label 'help wanted'");
  });
});

describe('shared guidance', () => {
  it('names both vocabularies and the omit-rather-than-guess rule', () => {
    expect(DISPATCH_HINT_GUIDANCE).toContain('model:light|medium|heavy');
    expect(DISPATCH_HINT_GUIDANCE).toContain('effort:low|medium|high|xhigh|max');
    expect(DISPATCH_HINT_GUIDANCE).toContain('Omit an axis rather than guessing');
    expect(DISPATCH_HINT_GUIDANCE).toContain('Do NOT stamp `medium` on both');
    expect(DISPATCH_HINT_GUIDANCE).toContain('repeated `--label`');
    expect(DISPATCH_HINT_GUIDANCE).toContain('Never relabel a deduplicated existing issue');
    expect(DISPATCH_HINT_GUIDANCE).toContain('good first issue');
    expect(DISPATCH_HINT_GUIDANCE).toContain('help wanted');
    expect(DISPATCH_HINT_GUIDANCE).toContain('NOT a good first issue');
    expect(DISPATCH_HINT_GUIDANCE).toContain('glab label create');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('model-light|model-medium|model-heavy');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('effort-low|effort-medium|effort-high|effort-xhigh|effort-max');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('good-first-issue');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).toContain('help-wanted');
    expect(JIRA_DISPATCH_HINT_GUIDANCE).not.toMatch(/model:light/);
  });
});

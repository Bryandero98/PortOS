import { describe, it, expect } from 'vitest';
import {
  buildStageGroups,
  stageGroupLabel,
  stageHaystack,
  isSystemStage,
  SYSTEM_STAGE_KEYS,
  OTHER_GROUP_LABEL,
} from './promptStageGroups.js';

const stage = (name, description = '') => ({ name, description });

describe('stageGroupLabel', () => {
  it('takes the prefix before an em-dash', () => {
    expect(stageGroupLabel('Creative Director — Treatment')).toBe('Creative Director');
    expect(stageGroupLabel('Pipeline — Reader Panel: The Editor')).toBe('Pipeline');
  });

  it('splits on the FIRST dash so a dashed suffix stays in the name', () => {
    expect(stageGroupLabel('Pipeline — Reverse Outline — v2')).toBe('Pipeline');
  });

  it('accepts an en-dash separator too', () => {
    expect(stageGroupLabel('Importer – Analyze')).toBe('Importer');
  });

  it('ignores hyphens that are not the separator', () => {
    expect(stageGroupLabel('Twin Spoken-vs-Written Comparison')).toBe('Twin');
  });

  it('falls back to a known leading word for pre-dash names', () => {
    expect(stageGroupLabel('CoS Agent Briefing')).toBe('CoS');
    expect(stageGroupLabel('Brain Daily Digest')).toBe('Brain');
    expect(stageGroupLabel('App Detection')).toBe('App Detection');
  });

  it('prefers the longest matching word prefix', () => {
    expect(stageGroupLabel('Model Personality Self-Profile')).toBe('Model Personality');
  });

  it('matches a word prefix on a hyphenated stage key', () => {
    expect(stageGroupLabel('cos-evaluate')).toBe('CoS');
    expect(stageGroupLabel('brain-classifier')).toBe('Brain');
  });

  it('does not match a word prefix mid-name', () => {
    expect(stageGroupLabel('Values-Alignment Scorer')).toBe(OTHER_GROUP_LABEL);
  });

  it('degrades to Other for empty / unknown names', () => {
    expect(stageGroupLabel('')).toBe(OTHER_GROUP_LABEL);
    expect(stageGroupLabel(null)).toBe(OTHER_GROUP_LABEL);
    expect(stageGroupLabel('Wholly Novel Thing')).toBe(OTHER_GROUP_LABEL);
  });
});

describe('isSystemStage', () => {
  it('recognizes the mirrored server list', () => {
    for (const key of SYSTEM_STAGE_KEYS) expect(isSystemStage(key)).toBe(true);
  });
  it('is false for user stages', () => {
    expect(isSystemStage('pipeline-prose-draft')).toBe(false);
    expect(isSystemStage(undefined)).toBe(false);
  });
});

describe('stageHaystack', () => {
  it('covers title, description and key, lowercased', () => {
    const h = stageHaystack('brain-daily-digest', stage('Brain Daily Digest', 'Summarize the day'));
    expect(h).toContain('brain daily digest');
    expect(h).toContain('summarize the day');
    expect(h).toContain('brain-daily-digest');
  });

  it('tolerates a missing config', () => {
    expect(stageHaystack('lonely-key', undefined)).toContain('lonely-key');
  });
});

describe('buildStageGroups', () => {
  const stages = {
    'pipeline-prose-draft': stage('Pipeline — Prose Draft', 'Draft the prose'),
    'pipeline-comic-script': stage('Pipeline — Comic Book Script', 'Panels and balloons'),
    'creative-director-treatment': stage('Creative Director — Treatment', 'Treatment doc'),
    'cos-evaluate': stage('CoS Task Evaluation', 'Grade a task'),
    'brain-classifier': stage('Brain Classifier', 'Classify a thought'),
    'values-alignment-scorer': stage('Values-Alignment Scorer', 'Score alignment'),
  };

  it('returns every stage grouped when unfiltered', () => {
    const { groups, matchCount, totalCount } = buildStageGroups(stages);
    expect(totalCount).toBe(6);
    expect(matchCount).toBe(6);
    expect(groups.map(g => g.label)).toEqual([
      'Brain', 'CoS', 'Creative Director', 'Pipeline', OTHER_GROUP_LABEL,
    ]);
  });

  it('pins Other last regardless of alphabetical position', () => {
    const { groups } = buildStageGroups(stages);
    expect(groups[groups.length - 1].label).toBe(OTHER_GROUP_LABEL);
  });

  it('sorts stages by display name within a group', () => {
    const { groups } = buildStageGroups(stages);
    const pipeline = groups.find(g => g.label === 'Pipeline');
    expect(pipeline.stages.map(([, c]) => c.name)).toEqual([
      'Pipeline — Comic Book Script',
      'Pipeline — Prose Draft',
    ]);
  });

  it('filters on the title', () => {
    const { groups, matchCount } = buildStageGroups(stages, { query: 'comic' });
    expect(matchCount).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].stages[0][0]).toBe('pipeline-comic-script');
  });

  it('filters on the description', () => {
    const { matchCount, groups } = buildStageGroups(stages, { query: 'balloons' });
    expect(matchCount).toBe(1);
    expect(groups[0].stages[0][0]).toBe('pipeline-comic-script');
  });

  it('filters on the stage key', () => {
    const { matchCount } = buildStageGroups(stages, { query: 'values-alignment' });
    expect(matchCount).toBe(1);
  });

  it('is case-insensitive and AND-joins terms', () => {
    expect(buildStageGroups(stages, { query: 'PIPELINE PROSE' }).matchCount).toBe(1);
    expect(buildStageGroups(stages, { query: 'pipeline treatment' }).matchCount).toBe(0);
  });

  it('treats a whitespace-only query as no filter', () => {
    expect(buildStageGroups(stages, { query: '   ' }).matchCount).toBe(6);
  });

  it('narrows to system stages when systemOnly is set', () => {
    const { groups, matchCount, totalCount } = buildStageGroups(stages, { systemOnly: true });
    expect(totalCount).toBe(6);
    expect(matchCount).toBe(2);
    expect(groups.flatMap(g => g.stages.map(([k]) => k)).sort()).toEqual(['brain-classifier', 'cos-evaluate']);
  });

  it('composes systemOnly with a query', () => {
    const { matchCount } = buildStageGroups(stages, { query: 'classify', systemOnly: true });
    expect(matchCount).toBe(1);
    expect(buildStageGroups(stages, { query: 'prose', systemOnly: true }).matchCount).toBe(0);
  });

  it('returns no groups but a real total when nothing matches', () => {
    const { groups, matchCount, totalCount } = buildStageGroups(stages, { query: 'zzzz' });
    expect(groups).toEqual([]);
    expect(matchCount).toBe(0);
    expect(totalCount).toBe(6);
  });

  it('handles an empty / missing stage map', () => {
    expect(buildStageGroups({})).toEqual({ groups: [], matchCount: 0, totalCount: 0 });
    expect(buildStageGroups(null).totalCount).toBe(0);
    expect(buildStageGroups(undefined).groups).toEqual([]);
  });

  it('groups a name-less stage by its key', () => {
    const { groups } = buildStageGroups({ 'cos-report-summary': {} });
    expect(groups[0].label).toBe('CoS');
  });
});

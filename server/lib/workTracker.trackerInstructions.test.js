/**
 * {trackerInstructions} regression guard (#3273, dispatch hints #4351).
 *
 * PLAN.md is still byte-pinned — that path has no labels. The forge/Jira
 * blocks grew independent `model:` / `effort:` dispatch-hint instructions, so
 * those are pinned by contract (vocabulary, repeated `--label`, category
 * preservation) rather than a frozen string. `{trackerInstructions}` is
 * substituted at dispatch time, so a stored reference-watch template does not
 * need a PROMPT_VERSIONS bump for this change.
 */

import { describe, it, expect } from 'vitest';
import { DISPATCH_HINT_GUIDANCE, JIRA_DISPATCH_HINT_GUIDANCE } from './dispatchLabels.js';
import { formatTrackerInstructions, TRACKER_FILING_PRESETS } from './workTracker.js';

const REF_WATCH = { slugPrefix: 'ref-watch-', label: 'reference-watch', issueLabel: 'reference-watch' };

const EXPECTED_PLAN = `This app records autonomous work in **PLAN.md** at the repo root ({repoPath}).

- **Inventory:** Read PLAN.md from {repoPath}. Every existing checkbox carries a \`[<slug>]\` ID — collect the \`[ref-watch-…]\` ones so you don't duplicate. If PLAN.md does not exist, create it with a single top-level heading (\`# {appName} — Development Plan\`) and a \`## Next Up\` section before appending.
- **Record** each proposal as a slug-tagged checklist item appended to the \`## Next Up\` section:
  \`\`\`markdown
  - [ ] [<slug>] **<Short title.>** From \`reference-watch\` review of <ref name> (commit(s) \`<sha>\` [+ \`<sha>\` …], <today's date>). <1–2 sentences.> Fix: <files + functions in {appName}>. <Estimated scope.>
  \`\`\`
  Place **Maybe — needs human call** items in a \`### Trigger-gated (waiting for a precondition)\` subsection if one exists; otherwise append them under \`## Next Up\`.
- **Finalize:** Commit the PLAN.md edit with message \`docs(reference-watch): propose <N> item(s) from <ref names>\`. Do NOT create branches or PRs — \`/claim\` (or the \`plan-task\` agent) picks the slugs up later.`;

function expectForgeDispatchContract(block, { cli, issueLabel }) {
  expect(block).toContain(DISPATCH_HINT_GUIDANCE.split('\n')[0]);
  expect(block).toContain('model:light|medium|heavy');
  expect(block).toContain('effort:low|medium|high|xhigh|max');
  expect(block).toContain('Omit an axis rather than guessing');
  expect(block).toContain(`--label ${issueLabel} --label plan [--label model:<tier>] [--label effort:<level>] [--label "good first issue"] [--label "help wanted"]`);
  expect(block).toContain('good first issue');
  expect(block).toContain('Do not relabel');
  expect(block).toContain('Issue-quality gate');
  expect(block).toContain('current refactors that pay off now are valid');
  expect(block).toContain('[category]');
  if (cli === 'gh') {
    expect(block).toContain(`gh label create ${issueLabel}`);
    expect(block).toContain('gh issue create');
  } else {
    expect(block).toContain(`glab label create --name ${issueLabel}`);
    expect(block).toContain('glab issue create');
  }
}

describe('formatTrackerInstructions — reference-watch PLAN.md byte-identity (#3273)', () => {
  it('renders the pre-extraction PLAN.md block byte-for-byte', () => {
    expect(formatTrackerInstructions('plan', REF_WATCH)).toBe(EXPECTED_PLAN);
  });

  it('renders the same PLAN.md block with no options (referenceRepos back-compat)', () => {
    expect(formatTrackerInstructions('plan')).toBe(EXPECTED_PLAN);
  });

  it('renders the same PLAN.md block from the reference-watch preset', () => {
    expect(formatTrackerInstructions('plan', TRACKER_FILING_PRESETS['reference-watch']))
      .toBe(EXPECTED_PLAN);
  });

  it('falls back to the PLAN.md block for an unknown/missing tracker', () => {
    expect(formatTrackerInstructions('nope')).toBe(EXPECTED_PLAN);
    expect(formatTrackerInstructions(undefined)).toBe(EXPECTED_PLAN);
  });
});

describe('formatTrackerInstructions — forge dispatch hints (#4351)', () => {
  it('teaches GitHub to create labels lazily and apply independent model/effort hints', () => {
    const github = formatTrackerInstructions('github', REF_WATCH);
    expectForgeDispatchContract(github, { cli: 'gh', issueLabel: 'reference-watch' });
    expect(github).toContain('--search "ref-watch in:title"');
    expect(formatTrackerInstructions('github')).toBe(github);
    expect(formatTrackerInstructions('github', TRACKER_FILING_PRESETS['reference-watch'])).toBe(github);
  });

  it('teaches GitLab the same contract with glab flags', () => {
    const gitlab = formatTrackerInstructions('gitlab', REF_WATCH);
    expectForgeDispatchContract(gitlab, { cli: 'glab', issueLabel: 'reference-watch' });
    expect(gitlab).toContain('glab issue list --label reference-watch');
    expect(formatTrackerInstructions('gitlab')).toBe(gitlab);
  });

  it('teaches Jira the hyphenated equivalent labels and leaves PLAN.md fallback intact', () => {
    const jira = formatTrackerInstructions('jira', REF_WATCH);
    expect(jira).toContain(JIRA_DISPATCH_HINT_GUIDANCE.split('\n')[0]);
    expect(jira).toContain('model-light|model-medium|model-heavy');
    expect(jira).toContain('effort-low|effort-medium|effort-high|effort-xhigh|effort-max');
    expect(jira).toContain('Do not relabel a ticket you skipped as a duplicate');
    expect(jira).toContain('Issue-quality gate');
    expect(jira).toContain('fall back to recording proposals in PLAN.md');
    expect(formatTrackerInstructions('jira')).toBe(jira);
  });
});

describe('formatTrackerInstructions — ux preset (#3273)', () => {
  const ux = TRACKER_FILING_PRESETS.ux;

  it('carries the ux slug prefix + label into every tracker block', () => {
    for (const tracker of ['plan', 'github', 'gitlab', 'jira']) {
      const block = formatTrackerInstructions(tracker, ux);
      expect(block).toContain('[ux-…]');
      expect(block).not.toContain('ref-watch');
      expect(block).not.toContain('reference-watch');
    }
  });

  it('labels filed forge issues `ux` (and `plan`) and searches titles by the slug stem', () => {
    const github = formatTrackerInstructions('github', ux);
    expect(github).toContain('gh label create ux --description "Proposed from a UX/design audit" --force');
    expect(github).toContain('--label ux --label plan [--label model:<tier>] [--label effort:<level>] [--label "good first issue"] [--label "help wanted"]');
    expect(github).toContain('--search "ux in:title"');
    expect(formatTrackerInstructions('gitlab', ux)).toContain('glab issue list --label ux');
    expect(formatTrackerInstructions('gitlab', ux)).toContain('--label ux --label plan');
  });

  it('keeps the read-only-on-source contract in every block', () => {
    for (const tracker of ['github', 'gitlab', 'jira']) {
      expect(formatTrackerInstructions(tracker, ux)).toContain('No source-code edits');
    }
  });

  it('leaves {appName}/{repoPath} unexpanded for the caller replace chain', () => {
    expect(formatTrackerInstructions('plan', ux)).toContain('{repoPath}');
    expect(formatTrackerInstructions('github', ux)).toContain('{appName}');
  });

  // The SHIPPED prompt (not the generator's mocked stand-in) must fully expand:
  // the tracker block is injected FIRST precisely because it carries {appName}/
  // {repoPath} of its own, and a token that survives reaches the agent literally.
  it('leaves no unexpanded {token} in the shipped ux prompt on any tracker', async () => {
    const { DEFAULT_TASK_PROMPTS } = await import('../services/taskPromptDefaults.js');
    const template = DEFAULT_TASK_PROMPTS['ux'];
    expect(template).toContain('{trackerInstructions}');

    for (const tracker of ['plan', 'github', 'gitlab', 'jira']) {
      const rendered = template
        .replace(/\{trackerInstructions\}/g, () => formatTrackerInstructions(tracker, ux))
        .replace(/\{appName\}/g, () => 'Example App')
        .replace(/\{repoPath\}/g, () => '/tmp/example-repo');
      expect(rendered.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g)).toBeNull();
    }
  });
});

describe('formatTrackerInstructions — repo-study complete labels', () => {
  const repoStudy = TRACKER_FILING_PRESETS['repo-study'];

  it('requires area, model, and effort labels on every new GitHub proposal', () => {
    const github = formatTrackerInstructions('github', repoStudy);
    expect(github).toContain('Repo-study complete-label contract (mandatory)');
    expect(github).toContain('area:*');
    expect(github).toContain('model:light|medium|heavy');
    expect(github).toContain('effort:low|medium|high|xhigh|max');
    expect(github).toContain('--label repo-study --label plan --label area:<area> --label model:<tier> --label effort:<level>');
    expect(github).toContain('gh label list --search area:');
  });

  it('uses the same complete-label contract on GitLab and JIRA', () => {
    const gitlab = formatTrackerInstructions('gitlab', repoStudy);
    expect(gitlab).toContain('--label repo-study --label plan --label area:<area> --label model:<tier> --label effort:<level>');
    expect(gitlab).toContain('glab label list');

    const jira = formatTrackerInstructions('jira', repoStudy);
    expect(jira).toContain('Repo-study complete-label contract (mandatory)');
    expect(jira).toContain('`area:<area>` + `model-<tier>` + `effort-<level>`');
  });
});

/**
 * Tree-wide guard on the two `glab` flag traps.
 *
 * Both cost real user-visible time before this existed, and both are invisible
 * in review because the wrong spelling LOOKS like the right one:
 *
 *   1. `-F json` on `glab issue list`. `-F` is not one flag across subcommands:
 *      on `mr list` / `mr view` / `issue view` / `repo view` / `label list` it is
 *      the shorthand for `--output` (text|json), but on `issue list` it is
 *      `--output-format` (details|ids|urls) while `--output` carries `-O`. So
 *      `glab issue list -F json` is accepted, IGNORED, and answers with the
 *      human table at exit 0 — parsed as "couldn't fetch", which is how the app
 *      Issues tab told a user with a working, authenticated `glab` to
 *      authenticate it.
 *   2. `--state <x>` on `glab mr list`. That flag does not exist; state is
 *      selected by presence flags (`--merged`, `--closed`, `--all`) and defaults
 *      to open. It exited non-zero on every call, so the GitLab arm of the
 *      zombie-issue reconcile scan skipped every cycle in silence.
 *
 * Per-caller argv assertions cannot cover this: the offenders were spread over
 * five modules and three different CLI runners, and a NEW call site is exactly
 * when the guard needs to fire. So this walks the whole server tree rather than
 * listing known files — the same discover-don't-enumerate shape as
 * `spawnCwd.test.js` and `cliChildEnv.test.js`.
 */

import { describe, it, expect } from 'vitest';
import { collectServerSources, readServerSource } from '../lib/testHelper.js';

// `-F json` as CODE — an argv array element pair, either quote style. Prompt
// prose spells it `-F json` (space-separated inside a template literal), so this
// pattern is naturally scoped to real call sites.
const ARGV_SHORTHAND_JSON = /(['"])-F\1\s*,\s*(['"])json\2/;

// `glab issue list … -F json` as TEXT — the shell form handed to an agent in a
// prompt, on one line.
const PROSE_ISSUE_LIST_SHORTHAND = /glab\s+issue\s+ls?i?s?t?\b[^\n]*?(?:^|\s)-F\s+json/m;

// `glab mr list --state <x>`, in either code or prose.
const PROSE_MR_LIST_STATE = /glab\s+mr\s+ls?i?s?t?\b[^\n]*?--state\b/m;
const ARGV_MR_LIST_STATE = /(['"])mr\1\s*,\s*(['"])list\2[^\n]*?(['"])--state\3/;

/**
 * Drop the parts of a source file that only TALK about the traps, so a comment
 * explaining the flag collision (this file, lib/glabArgs.js, issueReconcile.js)
 * doesn't read as an instance of it. Deliberately conservative: JSDoc blocks and
 * comment-only lines, nothing else — over-stripping would hide a real offender,
 * which is the failure that matters here. Prompt bodies live in template
 * literals, so they survive untouched.
 */
const stripCommentary = (src) => src
  .replace(/\/\*\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*)/.test(line))
  .join('\n');

const PATTERNS = [
  ['-F json argv pair', ARGV_SHORTHAND_JSON],
  ['glab issue list … -F json', PROSE_ISSUE_LIST_SHORTHAND],
  ['glab mr list --state', PROSE_MR_LIST_STATE],
  ['glab mr list --state argv', ARGV_MR_LIST_STATE],
];

// Stored per-install prompt DEFAULTS, which cannot be corrected by editing the
// string alone: each edit needs a PROMPT_VERSIONS bump plus the outgoing body
// preserved in PREVIOUS_DEFAULT_PROMPTS, or other installs never pick the fix up
// (CLAUDE.md "Distribution model"). Tracked in issue #4685 — removing an entry
// here is the whole acceptance criterion for that work.
//
// `previousDefaults.js` is frozen history: those strings must keep matching what
// older installs actually stored, so they stay listed permanently.
const EXEMPT = new Map([
  ['services/taskPromptDefaults/prompts.js', 'stored prompt defaults — needs a PROMPT_VERSIONS bump (#4685)'],
  ['services/taskPromptDefaults/previousDefaults.js', 'frozen historical snapshots — must match what older installs stored'],
]);

const offendingPatterns = (src) => {
  const code = stripCommentary(src);
  return PATTERNS.filter(([, re]) => re.test(code)).map(([name]) => name);
};

describe('glab flag traps are gone tree-wide', () => {
  it('no server source outside the deferred prompt defaults spells either trap', () => {
    const offenders = collectServerSources()
      .filter((rel) => !EXEMPT.has(rel))
      .map((rel) => [rel, offendingPatterns(readServerSource(rel))])
      .filter(([, hits]) => hits.length > 0);

    expect(
      offenders,
      'ask glab for JSON with withGlabJson()/execGlabJson (lib/glabArgs.js), and select MR state with --merged/--closed/--all',
    ).toEqual([]);
  });

  it('still matches the exempt files (guard is not vacuous)', () => {
    // If the patterns stop matching even the known-offending prompt bodies, the
    // scan broke — a rename, a reformat, a changed quote style — and the
    // assertion above would pass for the wrong reason.
    for (const [rel, why] of EXEMPT) {
      expect(
        offendingPatterns(readServerSource(rel)).length,
        `${rel} (${why}) no longer matches any pattern — the scan broke, or #4685 landed and this entry should be deleted`,
      ).toBeGreaterThan(0);
    }
  });

  it('the walk actually reaches the glab call sites (guard is not vacuous)', () => {
    // A scan that silently collected nothing would also report zero offenders.
    const sources = collectServerSources();
    expect(sources).toContain('services/gitlab.js');
    expect(sources).toContain('services/appIssues.js');
    expect(sources).toContain('services/issueReconcile.js');
    expect(sources).toContain('services/perpetualWork.js');
    expect(sources).toContain('services/layeredIntelligence/forgeFiler.js');
  });
});

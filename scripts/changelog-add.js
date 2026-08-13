/**
 * Write a changelog entry as a per-branch fragment — the conflict-free
 * replacement for appending to `.changelog/NEXT.md` by hand.
 *
 *   npm run changelog:add -- fixed "Notifications panel no longer clips on a phone."
 *   npm run changelog:add -- added --slug issue-3916 "Backups can be scheduled per app."
 *   git log -1 --format=%s | npm run changelog:add -- changed
 *
 * The slug defaults to the current branch's last segment, so two agents running
 * in parallel worktrees write two different files and their PRs merge cleanly.
 * See scripts/changelogFragments.js for why that is the fix and orderings are not.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { relative } from 'path';

import { REPO_ROOT, SECTIONS, slugFromBranch, slugify, writeFragment } from './changelogFragments.js';

const USAGE = `Usage: npm run changelog:add -- <${SECTIONS.join('|')}> [--slug <slug>] "entry text"

Reads the entry from stdin when no text argument is given.`;

/**
 * The branch this fragment belongs to.
 *
 * A detached HEAD (CI checkouts, a rebase in progress) has no branch name, in
 * which case the caller must pass --slug rather than get every detached run
 * writing to the same `HEAD.md`.
 */
function currentBranch() {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return branch === 'HEAD' ? '' : branch;
}

function parseArgs(argv) {
  const positional = [];
  let slug = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--slug') {
      slug = argv[i + 1] || '';
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { section: (positional[0] || '').toLowerCase(), text: positional.slice(1).join(' '), slug };
}

async function main() {
  const { section, text, slug: slugArg } = parseArgs(process.argv.slice(2));

  if (!SECTIONS.includes(section)) {
    console.error(`❌ Unknown changelog section "${section || '(none)'}"\n\n${USAGE}`);
    process.exit(1);
  }

  // `readFileSync(0)` blocks on an interactive terminal, so only reach for
  // stdin when it is actually a pipe and no text argument was supplied.
  const entry = text || (process.stdin.isTTY ? '' : readFileSync(0, 'utf8'));
  if (!entry.trim()) {
    console.error(`❌ No entry text given\n\n${USAGE}`);
    process.exit(1);
  }

  const slug = slugify(slugArg) || slugFromBranch(currentBranch());
  if (!slug) {
    console.error('❌ Could not derive a slug from the current branch (detached HEAD?) — pass --slug <slug>');
    process.exit(1);
  }

  const { path, appended } = await writeFragment({ section, slug, text: entry });
  console.log(`📝 ${appended ? 'Appended to' : 'Wrote'} ${relative(REPO_ROOT, path)}`);
}

await main();

/**
 * Fold every `.changelog/next/*.md` fragment into `.changelog/NEXT.md`.
 *
 *   npm run changelog:collect    # rewrite NEXT.md and delete the fragments
 *   npm run changelog:preview    # print what collection would produce, change nothing
 *
 * Run this before `/do:release`, which renames `NEXT.md` → `v{version}.md`.
 * Skipping it is not destructive — uncollected fragments simply ride along to
 * the next release — but the notes for this one would be missing entries.
 */

import { relative } from 'path';

import { collectFragments, NEXT_PATH, REPO_ROOT } from './changelogFragments.js';

async function main() {
  const preview = process.argv.includes('--preview');
  const { collected, invalid, markdown } = await collectFragments({ keep: preview });

  for (const filename of invalid) {
    console.error(`⚠️  Ignoring malformed changelog fragment: .changelog/next/${filename}`);
  }

  if (collected === 0) {
    console.log('✅ No changelog fragments to collect');
    // A malformed fragment is a real entry that will silently miss the release,
    // so it fails the run rather than reading as "nothing to do".
    process.exit(invalid.length > 0 ? 1 : 0);
  }

  if (preview) {
    console.log(markdown);
    console.log(`👀 Preview only — ${collected} fragment(s) left in place`);
    return;
  }

  console.log(`📜 Collected ${collected} changelog fragment(s) into ${relative(REPO_ROOT, NEXT_PATH)}`);
  if (invalid.length > 0) process.exit(1);
}

await main();

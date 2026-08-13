/**
 * Conflict-free changelog accumulation for parallel agents.
 *
 * The problem this solves: every CoS agent, `/claim` worktree and swarm worker
 * finishes its work by appending a bullet to the END of a section in
 * `.changelog/NEXT.md`. Two branches cut from the same base therefore add
 * different lines at the same place in the same file, which is the textbook
 * shape of a git merge conflict — so every second PR of a parallel run stalls
 * on a hand-resolved changelog, and at least once a conflict marker has been
 * committed to main and had to be swept up afterwards.
 *
 * Ordering tricks (alphabetize by agent id, blank line between entries) do not
 * fix this: git's 3-way merge conflicts on *adjacent* changed hunks regardless
 * of what the lines say. The only structural fix is to stop two branches from
 * writing the same file at all.
 *
 * So changelog entries are written as **fragments** — one small file per
 * branch per section, under `.changelog/next/`:
 *
 *     .changelog/next/fixed-issue-3916.md
 *     .changelog/next/added-agent-d3651f27.md
 *
 * Two branches adding two different paths merge cleanly every time, because
 * git merges by path. The slug defaults to the branch name's last segment,
 * which is already unique per agent/claim, so collisions need no coordination.
 *
 * `changelog-collect.js` folds the fragments back into `NEXT.md` before a
 * release, which keeps `/do:release` (a slashdo submodule command that renames
 * `NEXT.md` → `v{version}.md`) working exactly as it does today.
 *
 * Nothing here deletes or rewrites existing entries — collection is append-only
 * into the matching `## Section`, so a fragment that is never collected is
 * carried into the next release rather than lost.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { atomicWrite } from '../server/lib/fileUtils.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directory holding one-entry fragment files awaiting collection. */
const FRAGMENT_DIR = join(REPO_ROOT, '.changelog', 'next');

/** The accumulator `/do:release` renames into `v{version}.md`. */
export const NEXT_PATH = join(REPO_ROOT, '.changelog', 'NEXT.md');

/**
 * The Keep-a-Changelog sections, in the order `.changelog/README.md` documents.
 * A fragment's section is encoded in its filename prefix, so this list is also
 * the filename grammar.
 */
export const SECTIONS = ['added', 'changed', 'fixed', 'removed'];

/** `added` → `## Added` */
const sectionHeading = (section) => `## ${section[0].toUpperCase()}${section.slice(1)}`;

/**
 * Split a fragment filename into its section and slug.
 *
 * Returns `null` for anything that is not a well-formed fragment, so callers
 * can report the bad name rather than silently skipping (and dropping) it.
 * `.gitkeep` and other dotfiles are the caller's job to filter out first.
 */
export function parseFragmentName(filename) {
  const match = /^([a-z]+)-([a-z0-9][a-z0-9-]*)\.md$/.exec(filename);
  if (!match) return null;
  const [, section, slug] = match;
  if (!SECTIONS.includes(section)) return null;
  return { section, slug };
}

/**
 * Turn arbitrary text into a filename-safe slug.
 *
 * Returns `''` when nothing usable survives, which callers treat as "fall back
 * to the default" rather than writing a file named `-.md`.
 */
export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The default slug for a fragment: the last segment of the current branch.
 *
 * Branch names are already unique per unit of work — `claim/issue-3916`,
 * `next/issue-2148`, `cos/task-msrknq4w/agent-d3651f27` — and their last
 * segment (`issue-3916`, `agent-d3651f27`) is both unique and readable. That
 * is what makes the whole scheme coordination-free: an agent never has to know
 * what any other agent named its fragment.
 */
export function slugFromBranch(branch) {
  const lastSegment = String(branch || '').split('/').filter(Boolean).pop() || '';
  return slugify(lastSegment);
}

/**
 * Normalize entry text into changelog bullets.
 *
 * Hand-written fragments arrive either as bullets already or as bare prose; a
 * bare paragraph becomes one bullet so `changelog-add.js "some text"` is the
 * shortest possible call. Blank lines between bullets are dropped — the
 * collector controls spacing in the assembled file.
 */
export function toBullets(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (!/^[-*]\s/m.test(trimmed)) return [`- ${trimmed.replace(/\s*\n\s*/g, ' ')}`];
  return trimmed
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\*\s/, '- '));
}

/**
 * Every fragment on disk, sorted by filename.
 *
 * Sorting is what makes collection deterministic: two installs collecting the
 * same fragment set produce byte-identical NEXT.md, so a collect run is never
 * itself a source of merge noise.
 */
export function readFragments(dir = FRAGMENT_DIR) {
  if (!existsSync(dir)) return { fragments: [], invalid: [] };
  const fragments = [];
  const invalid = [];
  for (const filename of readdirSync(dir).sort()) {
    if (filename.startsWith('.')) continue;
    const parsed = parseFragmentName(filename);
    if (!parsed) {
      invalid.push(filename);
      continue;
    }
    const bullets = toBullets(readFileSync(join(dir, filename), 'utf8'));
    if (bullets.length === 0) {
      invalid.push(filename);
      continue;
    }
    fragments.push({ ...parsed, path: join(dir, filename), bullets });
  }
  return { fragments, invalid };
}

/**
 * Split a changelog document into a preamble plus one block per `## Heading`.
 *
 * Unknown headings are preserved verbatim and in place — a released file may
 * carry `## Overview` or `## Full Changelog`, and collection must not reorder
 * or drop them.
 */
function splitSections(markdown) {
  const lines = markdown.split('\n');
  const preamble = [];
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { heading: line, title: heading[1].toLowerCase(), body: [] };
      blocks.push(current);
      continue;
    }
    (current ? current.body : preamble).push(line);
  }
  return { preamble, blocks };
}

/** Drop leading/trailing blank lines from a section body. */
const trimBlanks = (lines) => {
  const start = lines.findIndex((line) => line.trim());
  return start === -1 ? [] : lines.slice(start, lines.findLastIndex((line) => line.trim()) + 1);
};

/**
 * Append `bullets` to `markdown` under `## Section`, creating the section when
 * it is absent.
 *
 * A new section is inserted so the known sections stay in `SECTIONS` order
 * relative to each other, without disturbing unknown ones.
 */
export function appendToSection(markdown, section, bullets) {
  if (bullets.length === 0) return markdown;
  const { preamble, blocks } = splitSections(markdown);
  const title = section.toLowerCase();
  const existing = blocks.find((block) => block.title === title);

  if (existing) {
    existing.body = [...trimBlanks(existing.body), ...bullets];
  } else {
    const rank = SECTIONS.indexOf(title);
    const block = { heading: sectionHeading(title), title, body: [...bullets] };
    const followerIndex = blocks.findIndex((candidate) => {
      const candidateRank = SECTIONS.indexOf(candidate.title);
      return candidateRank !== -1 && candidateRank > rank;
    });
    if (followerIndex === -1) blocks.push(block);
    else blocks.splice(followerIndex, 0, block);
  }

  const rendered = blocks.map((block) => [block.heading, '', ...trimBlanks(block.body)].join('\n'));
  const head = trimBlanks(preamble);
  return [...(head.length ? [head.join('\n')] : []), ...rendered].join('\n\n') + '\n';
}

/**
 * Fold every fragment into the target changelog and (unless `keep`) delete them.
 *
 * Returns what happened so the CLI can report it and tests can assert on it
 * without re-reading the filesystem. `invalid` is surfaced rather than thrown
 * on so one malformed name cannot strand every other agent's entry.
 */
export async function collectFragments({ dir = FRAGMENT_DIR, target = NEXT_PATH, keep = false } = {}) {
  const { fragments, invalid } = readFragments(dir);
  if (fragments.length === 0) return { collected: 0, invalid, markdown: null };

  let markdown = existsSync(target) ? readFileSync(target, 'utf8') : '';
  for (const section of SECTIONS) {
    const bullets = fragments
      .filter((fragment) => fragment.section === section)
      .flatMap((fragment) => fragment.bullets);
    markdown = appendToSection(markdown, section, bullets);
  }

  if (!keep) {
    // atomicWrite (temp + rename), not a plain write: the very next statement
    // deletes the fragments, which are the only other copy of these entries. A
    // write torn by a kill or a full disk would otherwise leave a truncated
    // changelog behind.
    await atomicWrite(target, markdown);
    for (const fragment of fragments) rmSync(fragment.path);
  }

  return { collected: fragments.length, invalid, markdown };
}

/**
 * Write (or extend) the fragment for a section + slug.
 *
 * Appending to an existing file rather than minting a suffixed one is
 * deliberate: a branch that ships several fixes keeps them in one file, and the
 * file is only ever touched by that one branch, so appending stays conflict-free.
 */
export async function writeFragment({ section, slug, text, dir = FRAGMENT_DIR }) {
  if (!SECTIONS.includes(section)) {
    throw new Error(`Unknown changelog section "${section}" — expected one of ${SECTIONS.join(', ')}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Unusable changelog slug "${slug}" — expected lowercase letters, digits and dashes`);
  }
  const bullets = toBullets(text);
  if (bullets.length === 0) throw new Error('Refusing to write an empty changelog entry');

  const path = join(dir, `${section}-${slug}.md`);
  const existing = existsSync(path) ? toBullets(readFileSync(path, 'utf8')) : [];
  await atomicWrite(path, `${[...existing, ...bullets].join('\n')}\n`);
  return { path, appended: existing.length > 0 };
}

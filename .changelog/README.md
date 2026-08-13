# Release Changelogs

This directory contains detailed release notes for each version of PortOS.

**No root CHANGELOG.md needed** - all changelog content lives in this directory.

## Structure

### next/ — Where You Write Your Entry

**Write your changelog entry as a fragment file, not by appending to `NEXT.md`.**

```bash
npm run changelog:add -- fixed "Notifications panel no longer clips on a phone."
```

That writes `.changelog/next/fixed-<your-branch>.md`. Sections are `added`,
`changed`, `fixed`, `removed`.

The slug defaults to the last segment of your current branch (`claim/issue-3916`
→ `issue-3916`, `cos/task-x/agent-d3651f27` → `agent-d3651f27`), which is already
unique per unit of work. Pass `--slug <slug>` to override — required on a
detached HEAD, since there is no branch name to derive from. Adding a second
entry for the same branch and section appends to the same file rather than
creating another one.

Writing the file by hand is fine too; the CLI just gets the name and the bullet
formatting right.

#### Why fragments

Every parallel agent, `/claim` worktree, and swarm worker used to append a
bullet to the end of the same section of the same file. Two branches cut from
the same base therefore added different lines in the same place — the textbook
shape of a merge conflict. Every second PR of a parallel run stalled on a
hand-resolved changelog, and conflict markers have reached `main` more than once.

Ordering conventions do not fix this. Alphabetizing by agent id, or leaving a
blank line between entries, still leaves both branches editing adjacent lines,
and git's three-way merge conflicts on adjacent changed hunks regardless of what
the lines say. The only structural fix is for two branches never to write the
same file: **git merges by path**, so two different paths always merge cleanly.

This is the same fragment/"news file" pattern used by towncrier, reno, and
changesets. `scripts/changelogFragments.js` carries the implementation notes.

#### Collecting before a release

`npm run changelog:collect` folds every fragment into `NEXT.md` under its
matching heading (creating the heading when absent) and deletes the fragments.
**Run it before `/do:release`.**

`npm run changelog:preview` prints the same result and changes nothing, which is
how to read the full set of unreleased notes while entries are still split
across fragments.

Collection is append-only and deterministic — fragments are folded in filename
order, so two installs collecting the same set produce identical output. Nothing
is lost by forgetting to collect: uncollected fragments simply ride along to the
next release.

#### Why `NEXT.md` is deliberately not union-merged

`.gitattributes` marks `.changelog/next/*.md` with git's built-in `union` merge
driver. That covers the one residual fragment collision: two branches whose
names share a last segment derive the same slug and write the same file, where
keeping both bullets is the right answer. A fragment is short-lived — created on
a branch, deleted at collection — so it has no cross-release failure mode.

`NEXT.md` is **not** union-merged, and that is on purpose even though it looks
like the same append-only shape. `/do:release` renames `NEXT.md` to
`v{version}.md` and starts a fresh one, and git does not pair that rename
because the path still exists on `main`. Any branch that outlives a release is
therefore a plain modify/modify on `NEXT.md`, and union resolves it by keeping
both sides — reviving the **entire previous release's entries** into the next
release's notes, cleanly, with no conflict and no warning. Verified both ways:
with union the merge succeeds and republishes the old entries; without it git
raises a conflict, which is the correct outcome.

So a direct append to `NEXT.md` on a branch still conflicts with a parallel one.
That is not a gap to be patched — it is the reason to write fragments.

### NEXT.md — Unreleased Changes Accumulator

`NEXT.md` accumulates collected entries across multiple commits until a release
is created.

- `/do:release` (a Claude Code slash command skill) renames `NEXT.md` to `v{version}.md` and finalizes it with the version number and release date. The release workflow then uses this versioned file for the GitHub release notes
- Do NOT create versioned changelog files manually — `/do:release` handles that
- Editing `NEXT.md` directly still works, and is the right move when correcting an entry that is already collected. For a *new* entry on a branch, write a fragment instead

### Versioned Files

Each release has its own markdown file:

```
v{major}.{minor}.{patch}.md
```

These are created automatically by `/do:release` from `NEXT.md`.

## Format

Each changelog file should follow this structure:

```markdown
# Release v{version}

Released: YYYY-MM-DD

## Overview

A brief summary of the release.

## Added

- Feature descriptions

## Changed

- What was changed

## Fixed

- Description of what was fixed

## Removed

- What was removed

## Full Changelog

**Full Diff**: https://github.com/atomantic/PortOS/compare/v{prev}...v{current}
```

## Workflow Integration

The GitHub Actions release workflow (`.github/workflows/release.yml`) automatically:

1. Checks for a changelog file matching the version in `package.json`
2. If found, uses it as the GitHub release description
3. If not found, falls back to generating a simple changelog from git commits

## Development Workflow

1. **During Development**: `npm run changelog:add -- <section> "entry"` writes a
   per-branch fragment under `.changelog/next/`. Never append a new entry to
   `NEXT.md` on a branch — that is what makes parallel agents collide.

2. **Before Release**: `npm run changelog:collect` folds the fragments into
   `NEXT.md`. This is the first step of `/do:release`.

3. **During Release** (`/do:release`):
   - Determines the version bump from conventional commit prefixes
   - Bumps `package.json` version
   - Renames `NEXT.md` → `v{new_version}.md`
   - Adds version header, release date, and diff link
   - Commits the version bump + finalized changelog

## Style Rules

Release notes are read by end users — not by the developer who wrote the change.
Write so a non-PortOS-developer can understand what changed and decide whether
they care about this release.

### Do
- **One sentence per change.** Two if a meaningful "why" needs to land. Major
  features may warrant a short paragraph, never a code review.
- **Lead with the user-visible effect.** "App deploy modal can be dismissed
  while a deploy is running" — not "DeployPanel.jsx now renders an X button
  unconditionally."
- **Use plain product language.** Page names ("Apps page header"), feature
  names ("Writers Room"), button labels ("+ Add"), and concrete UI elements
  are fine. Internal identifiers are not.
- **Group related entries.** When a single feature spans many sub-bullets
  (e.g. ten Writers Room changes), introduce it once with a short paragraph
  and follow with terse bullets, rather than ten separate paragraph entries.
- **Update the changelog as you work** so detail doesn't have to be
  reconstructed at release time.

### Don't
- **No file paths, module names, function names, route paths, or CSS class
  names.** If you find yourself writing `server/services/foo.js`,
  `composeStyledPrompt`, or `flex-col gap-2`, stop and rewrite from the user's
  point of view.
- **No "Touched:" / "New file:" / "Removed:" footers.** Those belong in commit
  messages, PRs, or `git log`.
- **No `[plan-id]` slug prefixes.** Slugs like `[data-versioning-split-pipeline-issues]`
  are for grep-ability across commits, branches, and PR titles — keep them out of
  user-facing release notes.
- **No internal data shapes.** "Each Work now carries `imageStyle = { presetId,
  prompt, negativePrompt }`" should be "Each Writers Room work can pin a world
  style preset that prefixes every scene's image prompt."
- **No deep technical rationale.** React StrictMode race details, diffusion
  token weighting, ffmpeg filter graphs, and Zod schema names belong in commit
  bodies / PR descriptions, not release notes.
- **No `/do:release` meta**. Don't reference the changelog tooling itself.
- **Don't create versioned changelog files manually** (use `/do:release`).
- **Don't bump the version manually** — only `/do:release` does that.
- **Don't leave vague entries** like "various improvements" or "general fixes."

### Style Examples

**Bad** (what verbose entries actually look like — file paths, paragraph length, internal API):

> **Mobile sidebar footer — version + icons no longer overflow the nav.** The
> expanded sidebar drawer footer rendered the version label and four 40×40
> touch-target icons (Ambient, theme toggle, voice toggle, notifications) on a
> single `flex justify-between` row. On mobile the sidebar is `w-56` (224px)…
> Touched: `client/src/components/Layout.jsx`.

**Good** (one sentence, user perspective, no internals):

> Mobile navigation drawer footer no longer clips the notification bell.

**Bad** (multi-paragraph code review with module names):

> **Writers Room — vertical Storyboard companion + UX cleanup.** The
> AI/Outline/Versions tabbed sidebar is replaced with an always-on
> `StoryboardPanel`… New files: `StoryboardPanel.jsx`, `SceneCard.jsx`,
> `CharactersBible.jsx`. Touched: `client/src/components/writers-room/WorkEditor.jsx`…

**Good** (intro paragraph + terse bullets, all user-facing language):

> **Writers Room storyboard.** The right column is now an always-on storyboard
> showing each scene as a card with image, slugline, summary, and character
> chips. Click a card to jump to that scene in your prose; per-card overflow
> menu adds *Why this image / Check characters / Editorial pass / Jump to prose*.
> Mobile gets a Writing/Storyboard toggle instead of a stacked layout.

## Maintenance

### Updating Past Releases

If you need to update a past release's changelog:

1. Edit the `.changelog/v{version}.md` file
2. Update the GitHub release manually:
   ```bash
   gh release edit v{version} --notes-file .changelog/v{version}.md
   ```
